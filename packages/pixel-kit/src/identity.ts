import type { BrowserCookie } from "@shopify/web-pixels-extension";

export const TRACKING_ID_COOKIE = "_tp_tid";
export const SESSION_ID_COOKIE = "_tp_sid";

const TRACKING_ID_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year
const SESSION_ID_MAX_AGE_SECONDS = 60 * 30; // 30 min inactivity window

/**
 * Cryptographically secure UUID v4 (spec section 4: "UUID v4
 * criptograficamente segura"). Prefers the native `crypto.randomUUID()`
 * (available in all browsers Shopify's pixel sandbox targets); falls back
 * to manually assembling a v4 UUID from `crypto.getRandomValues` for older
 * runtimes — never `Math.random()`, which is not cryptographically secure.
 */
export function generateUuidV4(cryptoObj: Crypto = crypto): string {
  if (typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface IdentityResult {
  id: string;
  isNew: boolean;
}

async function getOrCreateCookieId(
  cookie: BrowserCookie,
  name: string,
  maxAgeSeconds: number,
  cryptoObj: Crypto,
): Promise<IdentityResult> {
  const existing = await cookie.get(name);
  if (existing) {
    return { id: existing, isNew: false };
  }
  const id = generateUuidV4(cryptoObj);
  await cookie.set(`${name}=${id}; Max-Age=${maxAgeSeconds}; Path=/; SameSite=Lax`);
  return { id, isNew: true };
}

/** The visitor-level identifier. Long-lived, never regenerated once set —
 * a `tracking_id` can span many sessions (spec section 4). */
export function getOrCreateTrackingId(
  cookie: BrowserCookie,
  cryptoObj: Crypto = crypto,
): Promise<IdentityResult> {
  return getOrCreateCookieId(cookie, TRACKING_ID_COOKIE, TRACKING_ID_MAX_AGE_SECONDS, cryptoObj);
}

/** The visit-level identifier. Short-lived; callers should re-set it (via
 * `refreshSessionId`) on every event to slide the inactivity window,
 * exactly like a typical analytics session. */
export function getOrCreateSessionId(
  cookie: BrowserCookie,
  cryptoObj: Crypto = crypto,
): Promise<IdentityResult> {
  return getOrCreateCookieId(cookie, SESSION_ID_COOKIE, SESSION_ID_MAX_AGE_SECONDS, cryptoObj);
}

/** Slides the session cookie's inactivity window without changing its value. */
export async function refreshSessionId(cookie: BrowserCookie, sessionId: string): Promise<void> {
  await cookie.set(
    `${SESSION_ID_COOKIE}=${sessionId}; Max-Age=${SESSION_ID_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`,
  );
}
