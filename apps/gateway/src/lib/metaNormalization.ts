import { createHash } from "node:crypto";

/**
 * Normalization/hashing rules verified against Meta's official
 * "Conversions API — Customer Information Parameters" documentation
 * (developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters,
 * Phase 10 research) — see docs/PHASE_LOG.md Phase 10 for the exact
 * per-field rules quoted from that page and the one linked sub-page
 * ("Hashing details") that 404'd at research time, same situation as the
 * Shopify Web Pixels docs page in Phase 4: the parent page's own table was
 * complete enough to implement against, so that's what this is built from.
 *
 * ALL hashed fields use SHA-256, lower-case hex digest, over UTF-8 bytes.
 * A field that is missing, empty, or normalizes to an empty string is
 * OMITTED from the result entirely — never hashed as an empty string.
 * Hashing an empty string produces a fixed, well-known SHA-256 value
 * (e63b19...), and sending that as if it were a real customer's data
 * would be worse than sending nothing: it's a fabricated signal, exactly
 * what spec section 62 (golden rule) prohibits.
 */

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashField(raw: string | undefined | null, normalize: (value: string) => string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const normalized = normalize(raw);
  return normalized.length > 0 ? sha256Hex(normalized) : undefined;
}

function passthroughField(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const trimLower = (value: string): string => value.trim().toLowerCase();

/** "Lowercase only with no punctuation" — used for first/last name. Spaces
 * are deliberately KEPT (documented only as stripped for city, not for
 * name fields), since a double-barrelled name legitimately contains one. */
const lowerNoPunctuationKeepSpaces = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "");

/** City: "no punctuation, no special characters, and no spaces". */
const lowerNoPunctuationNoSpaces = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Phone: strip everything but digits (symbols, letters, spaces, dashes,
 * parentheses, a leading `+`), keeping the country-code digits Shopify
 * already includes when it sends E.164-formatted numbers.
 *
 * KNOWN LIMITATION, documented rather than papered over: Meta's own rule
 * also calls for stripping a national trunk prefix (a leading `0` after
 * the country code, common in many countries' local formats) before
 * hashing. Doing that correctly requires knowing the number's country
 * (a `+55` Brazilian number and a `+1` US number don't share the same
 * trunk-prefix convention), which in turn requires a real phone-numbering
 * library (e.g. `libphonenumber-js`) — not implemented in this phase. A
 * phone that already arrives in clean E.164 form (which is what Shopify's
 * own `customer.phone`/`billing_address.phone` typically provide) is
 * unaffected by this gap; a messier, locally-formatted number may hash to
 * a value Meta doesn't match against its own records. Flagged here and in
 * docs/PHASE_LOG.md Phase 10 as a follow-up rather than guessed at.
 */
const digitsOnly = (value: string): string => value.replace(/[^0-9]/g, "");

/** US zips are truncated to the first 5 digits; everything else is just
 * lowercased with internal whitespace/dashes removed. */
function normalizeZip(raw: string, countryCode: string | undefined): string {
  const cleaned = raw.trim().toLowerCase().replace(/[\s-]/g, "");
  if (countryCode?.trim().toUpperCase() === "US") {
    return cleaned.slice(0, 5);
  }
  return cleaned;
}

export interface RawMetaUserData {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  city?: string;
  /** 2-letter region/state code (Shopify's `province_code`), not the full
   * region name — Meta's rule expects the abbreviation, lower-cased. */
  stateCode?: string;
  zip?: string;
  /** 2-letter ISO 3166-1 alpha-2 code (Shopify's `country_code`). */
  countryCode?: string;
  /** A stable per-visitor identifier (this project uses `tracking_id`).
   * Hashing is only "Recommended", not mandated, by Meta's own docs for
   * this field — hashed here anyway as the more privacy-conservative
   * default; case is preserved (unlike the other fields) since Meta gives
   * no lower-casing rule for it and a UUID's case is otherwise meaningful. */
  externalId?: string;
  /** Never hashed — passed through as-is per Meta's documented rule. */
  clientIpAddress?: string;
  clientUserAgent?: string;
  fbc?: string;
  fbp?: string;
}

export interface NormalizedMetaUserData {
  em?: string;
  ph?: string;
  fn?: string;
  ln?: string;
  ct?: string;
  st?: string;
  zp?: string;
  country?: string;
  external_id?: string;
  client_ip_address?: string;
  client_user_agent?: string;
  fbc?: string;
  fbp?: string;
}

/**
 * Builds Meta CAPI's `user_data` object from whatever fields are
 * legitimately available — never inferring a missing one. Maximizing
 * Event Match Quality (docs/ARCHITECTURE.md section D) means sending
 * every field this function's caller actually has, not filling gaps.
 */
export function normalizeMetaUserData(raw: RawMetaUserData): NormalizedMetaUserData {
  const result: NormalizedMetaUserData = {};

  const em = hashField(raw.email, trimLower);
  if (em) result.em = em;

  const ph = hashField(raw.phone, digitsOnly);
  if (ph) result.ph = ph;

  const fn = hashField(raw.firstName, lowerNoPunctuationKeepSpaces);
  if (fn) result.fn = fn;

  const ln = hashField(raw.lastName, lowerNoPunctuationKeepSpaces);
  if (ln) result.ln = ln;

  const ct = hashField(raw.city, lowerNoPunctuationNoSpaces);
  if (ct) result.ct = ct;

  const st = hashField(raw.stateCode, trimLower);
  if (st) result.st = st;

  const zp = hashField(raw.zip, (value) => normalizeZip(value, raw.countryCode));
  if (zp) result.zp = zp;

  const country = hashField(raw.countryCode, trimLower);
  if (country) result.country = country;

  const externalId = hashField(raw.externalId, (value) => value.trim());
  if (externalId) result.external_id = externalId;

  const clientIp = passthroughField(raw.clientIpAddress);
  if (clientIp) result.client_ip_address = clientIp;

  const clientUserAgent = passthroughField(raw.clientUserAgent);
  if (clientUserAgent) result.client_user_agent = clientUserAgent;

  const fbc = passthroughField(raw.fbc);
  if (fbc) result.fbc = fbc;

  const fbp = passthroughField(raw.fbp);
  if (fbp) result.fbp = fbp;

  return result;
}
