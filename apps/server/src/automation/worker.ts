import { parentPort } from "node:worker_threads";

import type { AutomatedActionRequestV1 } from "@tabletop/game-sdk/server";
import { gameIdSchema, type JsonValue } from "@tabletop/protocol";

import { serverGameRegistry } from "../games/registry.js";

interface BotJob {
  readonly gameId: string;
  readonly id: string;
  readonly kind: "bot";
  readonly profileId: string;
  readonly request: AutomatedActionRequestV1<JsonValue>;
}

interface FallbackJob {
  readonly gameId: string;
  readonly id: string;
  readonly kind: "fallback";
  readonly reason: "disconnect" | "timeout";
  readonly request: AutomatedActionRequestV1<JsonValue>;
}

type WorkerJob = BotJob | FallbackJob;

if (!parentPort) throw new Error("AI Worker 缺少父线程消息端口");

parentPort.on("message", (job: WorkerJob) => {
  void execute(job);
});

async function execute(job: WorkerJob): Promise<void> {
  try {
    const game = serverGameRegistry.require(gameIdSchema.parse(job.gameId));
    const action =
      job.kind === "bot"
        ? await game.chooseBotAction({ ...job.request, profileId: job.profileId })
        : await game.chooseFallbackAction(job.request, job.reason);
    parentPort?.postMessage({ action, id: job.id, ok: true });
  } catch (error) {
    parentPort?.postMessage({
      error: error instanceof Error ? error.message : "AI 计算失败",
      id: job.id,
      ok: false,
    });
  }
}
