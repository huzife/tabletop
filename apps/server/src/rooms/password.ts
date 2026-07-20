import argon2 from "argon2";

import { Semaphore, SemaphoreSaturatedError } from "../lib/semaphore.js";

const roomPasswordOptions = {
  hashLength: 32,
  memoryCost: 32_768,
  parallelism: 1,
  timeCost: 2,
  type: argon2.argon2id,
} as const;

export class RoomPasswordService {
  readonly #semaphore: Semaphore;

  constructor(maxConcurrentHashes = 2, maxQueuedHashes = 16) {
    this.#semaphore = new Semaphore(maxConcurrentHashes, maxQueuedHashes);
  }

  async hash(password: string): Promise<string> {
    validateRoomPassword(password);
    return this.#run(async () => argon2.hash(password, roomPasswordOptions));
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      validateRoomPassword(password);
    } catch {
      return false;
    }
    return this.#run(async () => {
      try {
        return await argon2.verify(hash, password);
      } catch {
        return false;
      }
    });
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await this.#semaphore.run(operation);
    } catch (error) {
      if (error instanceof SemaphoreSaturatedError) {
        throw new RoomPasswordCapacityError();
      }
      throw error;
    }
  }
}

export class RoomPasswordCapacityError extends Error {
  constructor() {
    super("Room password worker queue is full");
    this.name = "RoomPasswordCapacityError";
  }
}

function validateRoomPassword(password: string): void {
  const length = Array.from(password).length;
  if (length < 1 || length > 128) {
    throw new RangeError("房间密码长度必须为 1 到 128 个字符");
  }
}
