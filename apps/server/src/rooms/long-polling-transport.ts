import type { ServerMessage } from "@tabletop/protocol";

const MAX_QUEUED_MESSAGES = 128;

export interface LongPollingClose {
  readonly code: number;
  readonly reason: string;
}

export interface LongPollingResult {
  readonly close?: LongPollingClose;
  readonly messages: readonly ServerMessage[];
}

interface PollWaiter {
  readonly resolve: (result: LongPollingResult) => void;
  readonly timer: NodeJS.Timeout;
}

export class LongPollingBusyError extends Error {
  constructor() {
    super("a long-poll request is already pending");
    this.name = "LongPollingBusyError";
  }
}

export class LongPollingTransport {
  readonly kind = "long-polling" as const;
  #close: LongPollingClose | undefined;
  #messages: ServerMessage[] = [];
  #waiter: PollWaiter | undefined;
  lastActivityAt = Date.now();

  get isOpen(): boolean {
    return this.#close === undefined;
  }

  close(code: number, reason: string): void {
    if (this.#close !== undefined) return;
    this.#close = { code, reason: reason.slice(0, 120) };
    this.#resolveWaiter();
  }

  poll(timeoutMs: number): Promise<LongPollingResult> {
    this.touch();
    if (this.#messages.length > 0 || this.#close !== undefined) {
      return Promise.resolve(this.#drain());
    }
    if (this.#waiter !== undefined) {
      return Promise.reject(new LongPollingBusyError());
    }

    return new Promise<LongPollingResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.#waiter?.timer !== timer) return;
        this.#waiter = undefined;
        resolve({ messages: [] });
      }, timeoutMs);
      timer.unref();
      this.#waiter = { resolve, timer };
    });
  }

  send(message: ServerMessage): boolean {
    if (this.#close !== undefined) return false;
    if (this.#waiter !== undefined) {
      this.#messages.push(message);
      this.#resolveWaiter();
      return true;
    }

    if (message.type === "room.snapshot" && message.causedBy === undefined) {
      const replaceIndex = this.#messages.findLastIndex(
        (candidate) =>
          candidate.type === "room.snapshot" &&
          candidate.roomId === message.roomId &&
          candidate.causedBy === undefined,
      );
      if (replaceIndex >= 0) {
        this.#messages[replaceIndex] = message;
        return true;
      }
    }

    if (message.type === "game.transient") {
      const replaceIndex = this.#messages.findLastIndex(
        (candidate) =>
          candidate.type === "game.transient" &&
          candidate.roomId === message.roomId &&
          candidate.matchId === message.matchId &&
          candidate.payload.senderSeatId === message.payload.senderSeatId,
      );
      if (replaceIndex >= 0) {
        this.#messages.splice(replaceIndex, 1);
      }
      if (this.#messages.length >= MAX_QUEUED_MESSAGES) return true;
      this.#messages.push(message);
      return true;
    }

    if (this.#messages.length >= MAX_QUEUED_MESSAGES) {
      const transientIndex = this.#messages.findIndex(
        (candidate) => candidate.type === "game.transient",
      );
      if (transientIndex < 0) return false;
      this.#messages.splice(transientIndex, 1);
    }
    this.#messages.push(message);
    return true;
  }

  touch(now = Date.now()): void {
    this.lastActivityAt = now;
  }

  #drain(): LongPollingResult {
    const messages = this.#messages;
    this.#messages = [];
    return {
      ...(this.#close === undefined ? {} : { close: this.#close }),
      messages,
    };
  }

  #resolveWaiter(): void {
    const waiter = this.#waiter;
    if (waiter === undefined) return;
    this.#waiter = undefined;
    clearTimeout(waiter.timer);
    waiter.resolve(this.#drain());
  }
}
