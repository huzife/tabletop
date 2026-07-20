import { describe, expect, it } from "vitest";

import { isValidUsername, normalizeUsername, UsernameValidationError } from "./username.js";

describe("normalizeUsername", () => {
  it("trims, applies NFKC and lowercases only the normalized ASCII key", () => {
    expect(normalizeUsername("  Ａlice-张_1  ")).toEqual({
      display: "Alice-张_1",
      normalized: "alice-张_1",
    });
  });

  it("accepts the documented character set and code-point boundaries", () => {
    expect(isValidUsername("用户A")).toBe(true);
    expect(isValidUsername("用".repeat(32))).toBe(true);
    expect(Array.from(normalizeUsername("用".repeat(32)).display)).toHaveLength(32);
  });

  it("rejects names outside the length range", () => {
    expect(() => normalizeUsername("ab")).toThrowError(
      expect.objectContaining<Partial<UsernameValidationError>>({ code: "USERNAME_LENGTH" }),
    );
    expect(() => normalizeUsername("a".repeat(33))).toThrowError(
      expect.objectContaining<Partial<UsernameValidationError>>({ code: "USERNAME_LENGTH" }),
    );
  });

  it("rejects spaces, punctuation and symbols after normalization", () => {
    for (const username of ["abc def", "用户。", "abc@def", "abc😀"]) {
      expect(() => normalizeUsername(username)).toThrowError(
        expect.objectContaining<Partial<UsernameValidationError>>({
          code: "USERNAME_CHARACTERS",
        }),
      );
      expect(isValidUsername(username)).toBe(false);
    }
  });
});
