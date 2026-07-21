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

function transientMessage(messageId: string, power: number) {
  return serverMessageSchema.parse({
    matchId: "match-test",
    messageId,
    payload: {
      event: { power, type: "aim.preview" },
      senderSeatId: "seat-1",
    },
    protocol: 1 as const,
    roomId: "room-test",
    serverTime: "2026-01-01T00:00:00.000Z",
    type: "game.transient" as const,
  });
}

function messageIdAt(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
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

  it("keeps only the latest queued transient event from each seat at its latest position", async () => {
    const transport = new LongPollingTransport();
    const first = transientMessage("00000000-0000-4000-8000-000000000004", 20);
    const authoritative = readyMessage("00000000-0000-4000-8000-000000000006");
    const latest = transientMessage("00000000-0000-4000-8000-000000000005", 70);

    expect(transport.send(first)).toBe(true);
    expect(transport.send(authoritative)).toBe(true);
    expect(transport.send(latest)).toBe(true);
    await expect(transport.poll(0)).resolves.toEqual({ messages: [authoritative, latest] });
  });

  it("silently drops a new transient event when the queue is full", async () => {
    const transport = new LongPollingTransport();
    const queued = Array.from({ length: 128 }, (_, index) => readyMessage(messageIdAt(index + 10)));
    for (const message of queued) expect(transport.send(message)).toBe(true);

    const dropped = transientMessage(messageIdAt(200), 80);
    expect(transport.send(dropped)).toBe(true);
    await expect(transport.poll(0)).resolves.toEqual({ messages: queued });
  });

  it("evicts a queued transient event before rejecting an authoritative message", async () => {
    const transport = new LongPollingTransport();
    const transient = transientMessage(messageIdAt(300), 40);
    const queued = Array.from({ length: 127 }, (_, index) =>
      readyMessage(messageIdAt(index + 301)),
    );
    const authoritative = readyMessage(messageIdAt(500));

    expect(transport.send(transient)).toBe(true);
    for (const message of queued) expect(transport.send(message)).toBe(true);
    expect(transport.send(authoritative)).toBe(true);
    await expect(transport.poll(0)).resolves.toEqual({
      messages: [...queued, authoritative],
    });
  });

  it("reports backpressure when a full queue contains only authoritative messages", () => {
    const transport = new LongPollingTransport();
    for (let index = 0; index < 128; index += 1) {
      expect(transport.send(readyMessage(messageIdAt(index + 600)))).toBe(true);
    }

    expect(transport.send(readyMessage(messageIdAt(800)))).toBe(false);
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
