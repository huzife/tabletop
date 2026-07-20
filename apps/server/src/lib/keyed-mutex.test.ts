import { describe, expect, it } from "vitest";

import { KeyedMutex } from "./keyed-mutex.js";

describe("KeyedMutex", () => {
  it("serializes the same key while allowing different keys", async () => {
    const mutex = new KeyedMutex<string>();
    const events: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = mutex.run("account-a", async () => {
      events.push("a1-start");
      await gate;
      events.push("a1-end");
    });
    const second = mutex.run("account-a", async () => {
      events.push("a2");
    });
    const other = mutex.run("account-b", async () => {
      events.push("b");
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["a1-start", "b"]);
    release?.();
    await Promise.all([first, second, other]);
    expect(events).toEqual(["a1-start", "b", "a1-end", "a2"]);
  });
});
