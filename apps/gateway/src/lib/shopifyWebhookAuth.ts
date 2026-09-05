import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a Shopify Admin webhook's `X-Shopify-Hmac-Sha256` header:
 * base64(HMAC-SHA256(rawRequestBody, appClientSecret)), compared in
 * constant time (verified Phase 7 against
 * shopify.dev/docs/apps/build/webhooks/subscribe/https — HMAC must be
 * computed over the exact raw bytes, before any JSON parsing/re-serialization,
 * which is why this is checked against `request.rawBody`, not
 * `JSON.stringify(request.body)`).
 */
export function verifyShopifyWebhookHmac(rawBody: string, signatureBase64: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");

  const expectedBuf = Buffer.from(expected, "base64");
  let receivedBuf: Buffer;
  try {
    receivedBuf = Buffer.from(signatureBase64, "base64");
  } catch {
    return false;
  }
  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, receivedBuf);
}
