import { describe, expect, it } from "vitest";

import { createSecretToken, hashSecretToken, secretTokenMatches } from "./session-token.js";

describe("session tokens", () => {
  it("only exposes the random value while retaining a deterministic hash", () => {
    const secret = "test-session-secret".repeat(2);
    const rotatedSecret = "rotated-session-secret".repeat(2);
    const token = createSecretToken(secret);

    expect(Buffer.from(token.value, "base64url")).toHaveLength(32);
    expect(token.hash).toEqual(hashSecretToken(token.value, secret));
    expect(secretTokenMatches(token.hash, token.value, secret)).toBe(true);
    expect(secretTokenMatches(token.hash, `${token.value}x`, secret)).toBe(false);
    expect(secretTokenMatches(token.hash, token.value, rotatedSecret)).toBe(false);
  });
});
