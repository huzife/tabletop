import { clientCommandSchema } from "@tabletop/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoomLongPollingTransport } from "./long-polling-transport";

const CONNECTION_ID = "connection-polling";
const MATCH_ID = "match-test";
const ROOM_ID = "room-test";

describe("RoomLongPollingTransport", () => {
  const NativeFetch = globalThis.fetch;

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: NativeFetch,
      writable: true,
    });
  });

  it("cancels a hanging transient request and sends an authoritative command immediately", async () => {
    vi.useFakeTimers();
    const requests: Array<{ body: unknown; signal: AbortSignal | null | undefined }> = [];
    installFetch(async (input, init) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname.endsWith("/commands") && init?.method === "POST") {
        const request = { body: JSON.parse(String(init.body)) as unknown, signal: init.signal };
        requests.push(request);
        if (isTransientCommand(request.body)) return new Promise<Response>(() => undefined);
        return jsonResponse({ accepted: true }, 202);
      }
      if (url.pathname.endsWith("/poll") && init?.method === "POST") {
        return new Promise<Response>(() => undefined);
      }
      return connectionResponse(url, init);
    });
    const onClose = vi.fn();
    const transport = new RoomLongPollingTransport({ onClose, onMessage: vi.fn() });
    await transport.open();

    expect(transport.send(transientCommand(1))).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal?.aborted).toBe(false);

    expect(transport.send(authoritativeCommand(2))).toBe(true);
    await Promise.resolve();

    expect(requests).toHaveLength(2);
    expect(requests[0]?.signal?.aborted).toBe(true);
    expect(requests[1]?.body).toMatchObject({ type: "room.seat.claim" });
    expect(vi.getTimerCount()).toBe(0);
    expect(onClose).not.toHaveBeenCalled();
    transport.close();
  });

  it("aborts in-flight poll and transient requests when closed", async () => {
    vi.useFakeTimers();
    let pollSignal: AbortSignal | null | undefined;
    let transientSignal: AbortSignal | null | undefined;
    installFetch(async (input, init) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname.endsWith("/commands") && init?.method === "POST") {
        transientSignal = init.signal;
        return new Promise<Response>(() => undefined);
      }
      if (url.pathname.endsWith("/poll") && init?.method === "POST") {
        pollSignal = init.signal;
        return new Promise<Response>(() => undefined);
      }
      return connectionResponse(url, init);
    });
    const onClose = vi.fn();
    const transport = new RoomLongPollingTransport({ onClose, onMessage: vi.fn() });
    await transport.open();
    transport.send(transientCommand(3));

    expect(pollSignal?.aborted).toBe(false);
    expect(transientSignal?.aborted).toBe(false);
    transport.close();

    expect(pollSignal?.aborted).toBe(true);
    expect(transientSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("drops a timed-out transient request without closing the transport", async () => {
    vi.useFakeTimers();
    let transientSignal: AbortSignal | null | undefined;
    installFetch(async (input, init) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname.endsWith("/commands") && init?.method === "POST") {
        transientSignal = init.signal;
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      if (url.pathname.endsWith("/poll") && init?.method === "POST") {
        return new Promise<Response>(() => undefined);
      }
      return connectionResponse(url, init);
    });
    const onClose = vi.fn();
    const transport = new RoomLongPollingTransport({ onClose, onMessage: vi.fn() });
    await transport.open();
    transport.send(transientCommand(4));

    await vi.advanceTimersByTimeAsync(2_000);

    expect(transientSignal?.aborted).toBe(true);
    expect(transport.isOpen).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(onClose).not.toHaveBeenCalled();
    transport.close();
  });
});

function installFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: vi.fn(implementation),
    writable: true,
  });
}

function connectionResponse(url: URL, init?: RequestInit): Promise<Response> {
  if (url.pathname === "/api/v1/room-connections" && init?.method === "POST") {
    return Promise.resolve(
      jsonResponse({ connectionId: CONNECTION_ID, messages: [connectionReadyMessage()] }, 201),
    );
  }
  if (url.pathname.startsWith("/api/v1/room-connections/") && init?.method === "DELETE") {
    return Promise.resolve(new Response(null, { status: 204 }));
  }
  throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
}

function transientCommand(seed: number) {
  return clientCommandSchema.parse({
    matchId: MATCH_ID,
    payload: { power: seed, type: "aim.preview" },
    protocol: 1,
    requestId: requestId(seed),
    roomId: ROOM_ID,
    type: "game.transient",
  });
}

function authoritativeCommand(seed: number) {
  return clientCommandSchema.parse({
    expectedRevision: 1,
    payload: { seatId: "seat-1" },
    protocol: 1,
    requestId: requestId(seed),
    roomId: ROOM_ID,
    type: "room.seat.claim",
  });
}

function requestId(seed: number): string {
  return `00000000-0000-4000-8000-${String(seed).padStart(12, "0")}`;
}

function isTransientCommand(command: unknown): boolean {
  return (
    typeof command === "object" &&
    command !== null &&
    "type" in command &&
    command.type === "game.transient"
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function connectionReadyMessage() {
  return {
    messageId: "00000000-0000-4000-8000-000000000010",
    payload: {
      connectionId: CONNECTION_ID,
      heartbeatIntervalMs: 20_000,
      pongTimeoutMs: 10_000,
    },
    protocol: 1,
    serverTime: "2026-07-16T10:00:00.000Z",
    type: "connection.ready",
  };
}
