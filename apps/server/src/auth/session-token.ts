import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface SecretToken {
  readonly hash: Buffer;
  readonly value: string;
}

export function hashSecretToken(value: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(value, "utf8").digest();
}

export function createSecretToken(secret: string): SecretToken {
  const value = randomBytes(32).toString("base64url");
  return { hash: hashSecretToken(value, secret), value };
}

export function secretTokenMatches(
  expectedHash: Uint8Array,
  candidate: string,
  secret: string,
): boolean {
  const candidateHash = hashSecretToken(candidate, secret);
  const expected = Buffer.from(expectedHash);

  return (
    expected.byteLength === candidateHash.byteLength && timingSafeEqual(expected, candidateHash)
  );
}
