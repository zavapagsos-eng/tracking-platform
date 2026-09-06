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

/**
 * Verifies an App Proxy signature against a LIST of candidate secrets,
 * accepting if any one of them produces a valid signature.
 *
 * Why this exists (bug found during the production readiness review after
 * Store C was added — see docs/PHASE_LOG.md): the doc comment on
 * `SHOPIFY_APP_PROXY_SECRET` in config.ts claims an App Proxy request is
 * "signed with the app's one OAuth client secret, the same value regardless
 * of which shop the request came from" — true only when a single Shopify
 * app is installed across every store. This project actually ships THREE
 * distinct apps (Store A/B/C, one per store, because Shopify allows only
 * one Web Pixel extension per app), each with its OWN client secret. A
 * same-origin `/apps/tracking/...` call from Hub is signed by App A's
 * secret; the equivalent call from Alpha Tactical or Rugged destino is
 * signed by App B's or App C's secret respectively. A single shared
 * `SHOPIFY_APP_PROXY_SECRET` can therefore verify requests from at most ONE
 * of the three stores — the other two would always get a false
 * `invalid_app_proxy_signature`, silently breaking cross-domain transfer
 * create/redeem for every store but one.
 *
 * The `shop` query param Shopify includes in every App Proxy request would
 * let us pick the exact right secret deterministically, but that mapping
 * (which store installed which of the three apps) isn't tracked anywhere
 * in config today — trying every configured app secret and accepting the
 * first match is simpler, doesn't require adding that mapping, and is not
 * a weaker security property: forging a signature still requires knowing
 * ONE of the real secrets, same as before.
 */
export function verifyAppProxySignatureAny(searchParams: URLSearchParams, secrets: readonly string[]): boolean {
  return secrets.some((secret) => verifyAppProxySignature(searchParams, secret));
}
