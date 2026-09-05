import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a Shopify App Proxy request signature.
 *
 * This is the mechanism the browser-executed pixel/theme code actually
 * uses to authenticate to privileged Gateway endpoints (transfer
 * create/redeem) — NOT a shared secret embedded in client-side JS, which
 * would leak the secret to anyone who views source (spec section 59:
 * never put a Shopify/app secret in the browser). Instead, the storefront
 * calls a same-origin path like `/apps/tracking/transfer/create`; Shopify's
 * edge proxies that to the Gateway and appends `shop`, `timestamp` and a
 * `signature` computed with the app's own client secret — a secret only
 * Shopify and this backend ever hold.
 *
 * Algorithm (per shopify.dev "Authenticate app proxies", verified Phase 0/4):
 * take every query parameter except `signature`, sort by key, render each
 * as `key=value` (comma-joining multi-value params), concatenate ALL pairs
 * with NO separator between them, HMAC-SHA256 with the app's client secret,
 * hex-encode, and compare in constant time against the `signature` param.
 */
export function verifyAppProxySignature(searchParams: URLSearchParams, secret: string): boolean {
  const received = searchParams.get("signature");
  if (!received) {
    return false;
  }

  const entries = new Map<string, string[]>();
  for (const [key, value] of searchParams.entries()) {
    if (key === "signature") continue;
    const existing = entries.get(key);
    if (existing) {
      existing.push(value);
    } else {
      entries.set(key, [value]);
    }
  }

  const sortedKeys = [...entries.keys()].sort();
  const canonical = sortedKeys.map((key) => `${key}=${entries.get(key)!.join(",")}`).join("");

  const expected = createHmac("sha256", secret).update(canonical).digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  let receivedBuf: Buffer;
  try {
    receivedBuf = Buffer.from(received, "hex");
  } catch {
    return false;
  }
  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, receivedBuf);
}
