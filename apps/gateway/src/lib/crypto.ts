import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Cryptographically secure opaque token (256 bits), URL-safe. Never a JWT /
 * self-describing structure on purpose — the token is a pure lookup key, so
 * a leaked or replayed token carries zero information and can be revoked
 * server-side simply by consulting the `transfers` row. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

/** The raw token is never persisted — only its hash, so a database read
 * alone can never be replayed as a valid token. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** HMAC-SHA256 signature over a canonical string (e.g. the raw request
 * body), used to authenticate calls from our own theme/app-proxy code to
 * privileged endpoints (transfer create/redeem) until Shopify App Proxy
 * signature verification is wired in during Phase 4/6. */
export function signHmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Constant-time comparison — never use `===` for signatures/secrets. */
export function verifyHmac(secret: string, payload: string, signature: string): boolean {
  const expected = Buffer.from(signHmac(secret, payload), "hex");
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}
