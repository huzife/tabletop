import { serverMessageSchema } from "@tabletop/protocol";
import { describe, expect, it } from "vitest";

import { LongPollingBusyError, LongPollingTransport } from "./long-polling-transport.js";

function readyMessage(messageId: string) {
  return serverMessageSchema.parse({
    messageId,
    payload: {
      connectionId: "connection-test",
      heartbeatIntervalMs: 20_000,
      pongTimeoutMs: 10_000,
    },
    protocol: 1 as const,
    serverTime: "2026-01-01T00:00:00.000Z",
    type: "connection.ready" as const,
  });
}

describe("LongPollingTransport", () => {
  it("delivers queued and waiting messages without losing order", async () => {
    const transport = new LongPollingTransport();
    const first = readyMessage("00000000-0000-4000-8000-000000000001");
    const second = readyMessage("00000000-0000-4000-8000-000000000002");

    expect(transport.send(first)).toBe(true);
    await expect(transport.poll(1_000)).resolves.toEqual({ messages: [first] });

    const waiting = transport.poll(1_000);
    expect(transport.send(second)).toBe(true);
    await expect(waiting).resolves.toEqual({ messages: [second] });
  });

  it("renews its lease only from client activity", async () => {
    const transport = new LongPollingTransport();
    transport.touch(1_000);

    expect(transport.send(readyMessage("00000000-0000-4000-8000-000000000003"))).toBe(true);
    expect(transport.lastActivityAt).toBe(1_000);

    await transport.poll(0);
    expect(transport.lastActivityAt).toBeGreaterThan(1_000);
  });

  it("allows only one outstanding poll and reports transport closure", async () => {
    const transport = new LongPollingTransport();
    const waiting = transport.poll(1_000);

    await expect(transport.poll(1_000)).rejects.toBeInstanceOf(LongPollingBusyError);
    transport.close(4_003, "removed");
    await expect(waiting).resolves.toEqual({
      close: { code: 4_003, reason: "removed" },
      messages: [],
    });
    expect(transport.isOpen).toBe(false);
  });
});
