import type { ClientCommand, ConnectionId, ServerMessage } from "@tabletop/protocol";

import { ApiClientError, roomConnectionApi } from "../api/client";

export interface LongPollingTransportClose {
  readonly code: number;
  readonly reason: string;
}

interface LongPollingTransportCallbacks {
  readonly onClose: (close: LongPollingTransportClose) => void;
  readonly onMessage: (message: ServerMessage) => void;
}

export class RoomLongPollingTransport {
  readonly #abortController = new AbortController();
  readonly #callbacks: LongPollingTransportCallbacks;
  #closed = false;
  #commandQueue: Promise<void> = Promise.resolve();
  #connectionId: ConnectionId | undefined;

  constructor(callbacks: LongPollingTransportCallbacks) {
    this.#callbacks = callbacks;
  }

  get isOpen(): boolean {
    return !this.#closed && this.#connectionId !== undefined;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#abortController.abort();
    const connectionId = this.#connectionId;
    if (connectionId !== undefined) {
      void roomConnectionApi.close(connectionId, true).catch(() => undefined);
    }
  }

  async open(): Promise<void> {
    try {
      const response = await roomConnectionApi.open(this.#abortController.signal);
      if (this.#closed) return;
      this.#connectionId = response.connectionId;
      for (const message of response.messages) {
        this.#callbacks.onMessage(message);
        if (this.#closed) return;
      }
      void this.#pollLoop();
    } catch (error) {
      this.#fail(error);
    }
  }

  send(command: ClientCommand): boolean {
    const connectionId = this.#connectionId;
    if (this.#closed || connectionId === undefined) return false;
    this.#commandQueue = this.#commandQueue
      .then(async () => {
        await roomConnectionApi.command(connectionId, command);
      })
      .catch((error: unknown) => {
        this.#fail(error);
      });
    return true;
  }

  #fail(error: unknown): void {
    if (this.#closed || isAbortError(error)) return;
    this.#closed = true;
    this.#abortController.abort();
    this.#callbacks.onClose(closeFromError(error));
  }

  async #pollLoop(): Promise<void> {
    while (!this.#closed && this.#connectionId !== undefined) {
      try {
        const response = await roomConnectionApi.poll(
          this.#connectionId,
          this.#abortController.signal,
        );
        if (this.#closed) return;
        for (const message of response.messages) {
          this.#callbacks.onMessage(message);
          if (this.#closed) return;
        }
        if (response.close !== undefined) {
          this.#closed = true;
          this.#callbacks.onClose(response.close);
          return;
        }
        if (response.messages.length === 0) {
          await new Promise((resolve) => window.setTimeout(resolve, 25));
        }
      } catch (error) {
        this.#fail(error);
        return;
      }
    }
  }
}

function closeFromError(error: unknown): LongPollingTransportClose {
  if (error instanceof ApiClientError) {
    if (error.code === "AUTH_SESSION_EXPIRED" || error.code.startsWith("AUTH_")) {
      return { code: 4004, reason: error.message };
    }
    if (error.code === "ROOM_PERMISSION_DENIED") {
      return { code: 4003, reason: error.message };
    }
    return { code: 1006, reason: error.message };
  }
  return { code: 1006, reason: "长轮询连接失败" };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
