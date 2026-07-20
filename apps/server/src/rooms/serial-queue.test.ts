import { describe, expect, it } from "vitest";

import { RoomSerialQueue } from "./serial-queue.js";

describe("RoomSerialQueue", () => {
  it("keeps command order and survives a rejected command", async () => {
    const queue = new RoomSerialQueue();
    const events: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = queue.run(async () => {
      events.push("first-start");
      await gate;
      events.push("first-end");
    });
    const rejected = queue.run(() => {
      events.push("rejected");
      throw new Error("expected");
    });
    const final = queue.run(() => events.push("final"));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["first-start"]);
    release?.();
    await first;
    await expect(rejected).rejects.toThrow("expected");
    await final;
    expect(events).toEqual(["first-start", "first-end", "rejected", "final"]);
  });
});
