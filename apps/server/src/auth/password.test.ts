import { describe, expect, it } from "vitest";

import { PasswordService, passwordSchema } from "./password.js";

describe("passwordSchema", () => {
  it("counts Unicode code points without trimming the password", () => {
    expect(passwordSchema.safeParse("密碼安全12").success).toBe(true);
    expect(passwordSchema.safeParse("  12  ").success).toBe(true);
    expect(passwordSchema.safeParse("12345").success).toBe(false);
    expect(passwordSchema.safeParse("a".repeat(129)).success).toBe(false);
  });
});

describe("PasswordService", () => {
  it("creates and verifies Argon2id hashes", async () => {
    const service = new PasswordService(1);
    const encoded = await service.hash("correct horse");

    expect(encoded).toMatch(/^\$argon2id\$/);
    await expect(service.verify(encoded, "correct horse")).resolves.toBe(true);
    await expect(service.verify(encoded, "wrong horse")).resolves.toBe(false);
  });
});
