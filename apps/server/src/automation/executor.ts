import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import type { AutomatedActionRequestV1, HostedGameServerModuleV1 } from "@tabletop/game-sdk/server";
import type { GameActionV1 } from "@tabletop/game-sdk";
import type { JsonValue } from "@tabletop/protocol";
import { ulid } from "ulid";

interface BotTask {
  readonly gameId: string;
  readonly kind: "bot";
  readonly profileId: string;
  readonly request: AutomatedActionRequestV1<JsonValue>;
  readonly timeBudgetMs: number;
}

interface FallbackTask {
  readonly gameId: string;
  readonly kind: "fallback";
  readonly reason: "disconnect" | "timeout";
  readonly request: AutomatedActionRequestV1<JsonValue>;
  readonly timeBudgetMs: number;
}

type AutomationTask = BotTask | FallbackTask;

interface QueuedTask {
  readonly id: string;
  readonly task: AutomationTask;
  attempts: number;
  reject(error: Error): void;
  resolve(action: GameActionV1): void;
  timer?: NodeJS.Timeout;
}

interface WorkerSuccess {
  readonly action: GameActionV1;
  readonly id: string;
  readonly ok: true;
}

interface WorkerFailure {
  readonly error: string;
  readonly id: string;
  readonly ok: false;
}

type WorkerResponse = WorkerFailure | WorkerSuccess;

export interface GameAutomationExecutor {
  chooseBotAction(
    gameId: string,
    game: HostedGameServerModuleV1,
    request: AutomatedActionRequestV1<JsonValue> & { readonly profileId: string },
    timeBudgetMs: number,
  ): Promise<GameActionV1>;
  chooseFallbackAction(
    gameId: string,
    game: HostedGameServerModuleV1,
    request: AutomatedActionRequestV1<JsonValue>,
    reason: "disconnect" | "timeout",
    timeBudgetMs: number,
  ): Promise<GameActionV1>;
  close(): Promise<void>;
}

export class InProcessAutomationExecutor implements GameAutomationExecutor {
  chooseBotAction(
    _gameId: string,
    game: HostedGameServerModuleV1,
    request: AutomatedActionRequestV1<JsonValue> & { readonly profileId: string },
    timeBudgetMs: number,
  ): Promise<GameActionV1> {
    return game.chooseBotAction({
      ...request,
      hardDeadlineMonotonicMs: performance.now() + timeBudgetMs,
    });
  }

  chooseFallbackAction(
    _gameId: string,
    game: HostedGameServerModuleV1,
    request: AutomatedActionRequestV1<JsonValue>,
    reason: "disconnect" | "timeout",
    timeBudgetMs: number,
  ): Promise<GameActionV1> {
    return game.chooseFallbackAction(
      { ...request, hardDeadlineMonotonicMs: performance.now() + timeBudgetMs },
      reason,
    );
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export class SingleWorkerAutomationExecutor implements GameAutomationExecutor {
  readonly #queue: QueuedTask[] = [];
  #active: QueuedTask | undefined;
  #closed = false;
  #worker: Worker | undefined;

  chooseBotAction(
    gameId: string,
    _game: HostedGameServerModuleV1,
    request: AutomatedActionRequestV1<JsonValue> & { readonly profileId: string },
    timeBudgetMs: number,
  ): Promise<GameActionV1> {
    const { profileId, ...baseRequest } = request;
    return this.#enqueue({ gameId, kind: "bot", profileId, request: baseRequest, timeBudgetMs });
  }

  chooseFallbackAction(
    gameId: string,
    _game: HostedGameServerModuleV1,
    request: AutomatedActionRequestV1<JsonValue>,
    reason: "disconnect" | "timeout",
    timeBudgetMs: number,
  ): Promise<GameActionV1> {
    return this.#enqueue({ gameId, kind: "fallback", reason, request, timeBudgetMs });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error("AI Worker 已关闭");
    if (this.#active) {
      this.#clearTimer(this.#active);
      this.#active.reject(error);
      this.#active = undefined;
    }
    for (const task of this.#queue.splice(0)) task.reject(error);
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker) await worker.terminate();
  }

  #enqueue(task: AutomationTask): Promise<GameActionV1> {
    if (this.#closed) return Promise.reject(new Error("AI Worker 已关闭"));
    if (this.#queue.length >= 128) return Promise.reject(new Error("AI 任务队列已满"));
    return new Promise<GameActionV1>((resolve, reject) => {
      this.#queue.push({ attempts: 0, id: ulid(), reject, resolve, task });
      this.#runNext();
    });
  }

  #runNext(): void {
    if (this.#closed || this.#active) return;
    const queued = this.#queue.shift();
    if (!queued) return;
    const worker = this.#ensureWorker();
    this.#active = queued;
    queued.attempts += 1;
    const hardDeadlineMonotonicMs = performance.now() + queued.task.timeBudgetMs;
    queued.timer = setTimeout(
      () => this.#failWorker(worker, new Error("AI 计算超过时间预算"), true),
      queued.task.timeBudgetMs + 250,
    );
    queued.timer.unref();
    worker.postMessage({
      ...queued.task,
      id: queued.id,
      request: { ...queued.task.request, hardDeadlineMonotonicMs },
    });
  }

  #ensureWorker(): Worker {
    if (this.#worker) return this.#worker;
    const sourceIsTypeScript = import.meta.url.endsWith(".ts");
    const sourceExtension = sourceIsTypeScript ? "ts" : "js";
    const workerUrl = new URL(`./worker.${sourceExtension}`, import.meta.url);
    const worker = sourceIsTypeScript
      ? new Worker(
          `import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))})` +
            `.then(({ tsImport }) => tsImport(${JSON.stringify(workerUrl.href)}, ` +
            `{ parentURL: ${JSON.stringify(import.meta.url)} }));`,
          { eval: true, name: "tabletop-ai" },
        )
      : new Worker(workerUrl, { name: "tabletop-ai" });
    worker.on("message", (message: unknown) => this.#handleMessage(worker, message));
    worker.on("error", (error) => this.#failWorker(worker, error, true));
    worker.on("exit", (code) => {
      if (code !== 0) this.#failWorker(worker, new Error(`AI Worker 异常退出（${code}）`), true);
    });
    this.#worker = worker;
    return worker;
  }

  #handleMessage(worker: Worker, message: unknown): void {
    if (worker !== this.#worker || !isWorkerResponse(message)) {
      this.#failWorker(worker, new Error("AI Worker 返回了无效消息"), false);
      return;
    }
    const active = this.#active;
    if (!active || message.id !== active.id) {
      this.#failWorker(worker, new Error("AI Worker 返回了失序消息"), false);
      return;
    }
    this.#clearTimer(active);
    this.#active = undefined;
    if (message.ok) active.resolve(message.action);
    else active.reject(new Error(message.error));
    this.#runNext();
  }

  #failWorker(worker: Worker, error: Error, retry: boolean): void {
    if (worker !== this.#worker) return;
    this.#worker = undefined;
    void worker.terminate();
    const active = this.#active;
    this.#active = undefined;
    if (active) {
      this.#clearTimer(active);
      if (retry && active.attempts < 2 && !this.#closed) this.#queue.unshift(active);
      else active.reject(error);
    }
    this.#runNext();
  }

  #clearTimer(task: QueuedTask): void {
    if (task.timer) clearTimeout(task.timer);
    delete task.timer;
  }
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.ok !== "boolean") return false;
  if (record.ok) return Boolean(record.action) && typeof record.action === "object";
  return typeof record.error === "string";
}
