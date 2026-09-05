import type { AttributionTouchRow } from "./journey.js";

export const ATTRIBUTION_MODELS = ["FIRST_TOUCH", "LAST_TOUCH", "LAST_NON_DIRECT", "LAST_PAID_TOUCH"] as const;
export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];

/**
 * The four analytical attribution models (docs/ARCHITECTURE.md section D),
 * computed independently and in parallel — never just a single "winner".
 * These are reporting/dashboard views over the same immutable touch
 * history; they do NOT decide what's sent to Meta CAPI (Phase 10 uses the
 * most recent `fbc`/`fbp` in the journey for that, regardless of which
 * model "wins" here — see the module comment below).
 */
export type AttributionModelResults = Record<AttributionModel, AttributionTouchRow | null>;

/**
 * `touches` MUST already be in chronological order (ascending
 * `occurred_at`) — exactly what `reconstructJourneyByTrackingId` /
 * `reconstructJourneyByOrderId` in lib/journey.ts already produce. This
 * module intentionally does not re-sort: it has no way to tell an
 * already-correct order from one a caller scrambled by mistake, and
 * silently re-sorting would hide that bug instead of a test catching it.
 */

/** Earliest touch in the journey — the very first ad-relevant visit,
 * regardless of channel (including "direct"). `null` only when the
 * visitor has no recorded touch at all. */
export function computeFirstTouch(touches: AttributionTouchRow[]): AttributionTouchRow | null {
  return touches[0] ?? null;
}

/** Most recent touch in the journey, regardless of channel. */
export function computeLastTouch(touches: AttributionTouchRow[]): AttributionTouchRow | null {
  return touches.length > 0 ? touches[touches.length - 1]! : null;
}

/** Most recent touch whose channel is NOT "direct" — i.e. the last time
 * the visitor arrived via an identifiable source (an ad, a referral, a
 * campaign link), skipping over any direct visits that happened after it.
 * `null` when every touch in the journey is direct (there is no
 * non-direct touch to attribute to — never fabricated as some other
 * channel). */
export function computeLastNonDirectTouch(touches: AttributionTouchRow[]): AttributionTouchRow | null {
  for (let i = touches.length - 1; i >= 0; i -= 1) {
    if (touches[i]!.source !== "direct") {
      return touches[i]!;
    }
  }
  return null;
}

/** Most recent touch flagged `is_paid` (see lib/attribution.ts
 * `deriveChannel` — `is_paid` is only ever true when an `fbclid`/`gclid`
 * backed it, never inferred from a UTM tag alone). `null` when the
 * visitor's journey contains no paid touch at all. */
export function computeLastPaidTouch(touches: AttributionTouchRow[]): AttributionTouchRow | null {
  for (let i = touches.length - 1; i >= 0; i -= 1) {
    if (touches[i]!.isPaid) {
      return touches[i]!;
    }
  }
  return null;
}

/** Computes all four models at once — this is what a Purchase's
 * attribution snapshot (and the dashboard's model switcher, Phase 13)
 * actually consumes. */
export function computeAllAttributionModels(touches: AttributionTouchRow[]): AttributionModelResults {
  return {
    FIRST_TOUCH: computeFirstTouch(touches),
    LAST_TOUCH: computeLastTouch(touches),
    LAST_NON_DIRECT: computeLastNonDirectTouch(touches),
    LAST_PAID_TOUCH: computeLastPaidTouch(touches),
  };
}
