import type { BrowserCookie } from "@shopify/web-pixels-extension";

const FBC_COOKIE = "_fbc";
const FBP_COOKIE = "_fbp";

const UTM_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "utm_id",
] as const;

export interface CapturedAttribution {
  fbclid?: string;
  fbc?: string;
  fbp?: string;
  /** Google Ads' own click id, appended to the landing URL the same way
   * `fbclid` is (Google's "auto-tagging" feature) — captured now, ahead of
   * any Google Ads campaign going live, purely so a real click isn't lost
   * before this column existed (see schema.ts's `gclid` comment). */
  gclid?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  utm_id?: string;
  landing_page?: string;
  referrer?: string;
}

/**
 * Formats an `fbclid` into Meta's documented `_fbc` cookie shape
 * (`fb.{subdomainIndex}.{creationTimeMs}.{fbclid}`). This is NOT
 * fabricating a click id — `fbclid` was legitimately present in the
 * landing URL; this only re-encodes it the way Meta's own Pixel would have,
 * for the case where Meta's Pixel isn't also present on the page (or ran
 * after ours) and never set the real `_fbc` cookie itself. If `_fbc`
 * already exists, callers must prefer the real cookie over this derivation
 * — see `captureAttribution` below.
 */
export function deriveFbcFromClickId(
  fbclid: string,
  creationTimeMs: number,
  subdomainIndex = 1,
): string {
  return `fb.${subdomainIndex}.${creationTimeMs}.${fbclid}`;
}

/**
 * Reads whatever attribution signals are legitimately present on this page
 * load: `fbclid`/UTMs from the URL query string, `_fbc`/`_fbp` from
 * top-frame cookies (via the Web Pixel's `browser.cookie`, which is how a
 * strict-sandbox pixel reaches cookies Meta's own Pixel.js set on the same
 * page — see docs/PHASE_LOG.md Phase 4). Nothing here is invented: a field
 * is simply absent from the result when its source data isn't present.
 */
export async function captureAttribution(
  cookie: BrowserCookie,
  locationHref: string,
  referrer: string,
  now: () => number = Date.now,
): Promise<CapturedAttribution> {
  const result: CapturedAttribution = {};

  let url: URL;
  try {
    url = new URL(locationHref);
  } catch {
    return result;
  }

  const fbclid = url.searchParams.get("fbclid");
  if (fbclid) {
    result.fbclid = fbclid;
  }

  const gclid = url.searchParams.get("gclid");
  if (gclid) {
    result.gclid = gclid;
  }

  for (const param of UTM_PARAMS) {
    const value = url.searchParams.get(param);
    if (value) {
      result[param] = value;
    }
  }

  if (locationHref) {
    result.landing_page = locationHref;
  }
  if (referrer) {
    result.referrer = referrer;
  }

  const existingFbc = await cookie.get(FBC_COOKIE);
  if (existingFbc) {
    result.fbc = existingFbc;
  } else if (fbclid) {
    // No real _fbc cookie yet but we do have a legitimate fbclid on this
    // very page load — derive and persist it so later events on this
    // domain (and our own server-side reconciliation) see a consistent value.
    const derived = deriveFbcFromClickId(fbclid, now());
    await cookie.set(`${FBC_COOKIE}=${derived}; Max-Age=${60 * 60 * 24 * 90}; Path=/; SameSite=Lax`);
    result.fbc = derived;
  }

  const existingFbp = await cookie.get(FBP_COOKIE);
  if (existingFbp) {
    result.fbp = existingFbp;
  }
  // Deliberately NOT synthesizing `_fbp` when absent: unlike `_fbc`, `fbp`
  // has no analogous "we already captured the real input" derivation — it
  // is purely a Meta-generated browser id. Fabricating one would violate
  // the "never invent fbp" rule (spec section 59).

  return result;
}
