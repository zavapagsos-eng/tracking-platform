/**
 * Classifies a Meta Graph API `http_error` response as either worth
 * retrying (transient) or not (retrying the identical request will just
 * fail again the same way). Codes verified against Meta's official error
 * handling guide (developers.facebook.com/docs/graph-api/guides/error-
 * handling, Phase 11 research):
 *   - 1  (API Unknown) / 2 (API Service): "possibly a temporary issue due
 *     to downtime — wait and retry."
 *   - 4  (API Too Many Calls) / 17 (API User Too Many Calls) /
 *     341 (Application limit reached) / 368 (Temporarily blocked for
 *     policy violations): rate limiting / throttling — retry after
 *     backing off.
 *   - 3  (API Method) / 10 (API Permission Denied) / 102 (API Session,
 *     OAuthException) / 190 (Access token expired) / the 200-299 "API
 *     Permission" range: the app/token itself lacks what it needs — the
 *     SAME request will fail again until a human fixes the credential or
 *     permission; retrying changes nothing.
 *
 * An error code outside both documented sets — including a response with
 * no numeric `error.code` at all (non-JSON body, unexpected shape) —
 * defaults to "retryable". That is the deliberately conservative choice:
 * wrongly retrying a permanent error only spends a few bounded extra
 * attempts before it lands in the dead-letter table anyway, whereas
 * wrongly treating a genuinely transient error as permanent would give up
 * on (and dead-letter) a Purchase send that a retry would have delivered.
 */
export type MetaErrorClassification = "retryable" | "permanent";

/** Documented in the module comment above — kept as an explicit constant
 * (rather than folded silently into the fallthrough) so the specific
 * codes this classification is based on stay visible and testable. */
const RETRYABLE_META_ERROR_CODES = new Set([1, 2, 4, 17, 341, 368]);
const PERMANENT_META_ERROR_CODES = new Set([3, 10, 102, 190]);

function extractMetaErrorCode(responseRedacted: unknown): number | undefined {
  if (
    responseRedacted !== null &&
    typeof responseRedacted === "object" &&
    "error" in responseRedacted
  ) {
    const error = (responseRedacted as { error?: unknown }).error;
    if (error !== null && typeof error === "object" && "code" in error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "number") return code;
    }
  }
  return undefined;
}

export function classifyMetaHttpError(responseRedacted: unknown): MetaErrorClassification {
  const code = extractMetaErrorCode(responseRedacted);
  if (code === undefined) return "retryable";
  if (PERMANENT_META_ERROR_CODES.has(code)) return "permanent";
  if (code >= 200 && code <= 299) return "permanent";
  if (RETRYABLE_META_ERROR_CODES.has(code)) return "retryable";
  return "retryable";
}
