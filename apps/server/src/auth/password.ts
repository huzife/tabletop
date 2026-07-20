import argon2 from "argon2";
import { z } from "zod";

import { Semaphore } from "../lib/semaphore.js";

const passwordCodePointLength = (value: string): number => Array.from(value).length;

export const passwordSchema = z
  .string()
  .refine((value) => passwordCodePointLength(value) >= 6, "密码至少需要 6 个字符")
  .refine((value) => passwordCodePointLength(value) <= 128, "密码最多允许 128 个字符");

const argon2Options = {
  hashLength: 32,
  memoryCost: 65_536,
  parallelism: 1,
  timeCost: 3,
  type: argon2.argon2id,
} as const;

export class PasswordService {
  readonly #semaphore: Semaphore;

  constructor(maxConcurrentHashes = 2) {
    this.#semaphore = new Semaphore(maxConcurrentHashes);
  }

  async hash(password: string): Promise<string> {
    const validated = passwordSchema.parse(password);
    return this.#semaphore.run(async () => argon2.hash(validated, argon2Options));
  }

  async verify(encodedHash: string, candidate: string): Promise<boolean> {
    return this.#semaphore.run(async () => {
      try {
        return await argon2.verify(encodedHash, candidate);
      } catch {
        return false;
      }
    });
  }
}
