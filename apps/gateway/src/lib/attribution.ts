import { schema, type Database } from "@tracking/db";
import type { TrackingEventV1 } from "@tracking/schema";

export interface TouchInput {
  trackingId: string;
  sessionId: string;
  attribution: TrackingEventV1["attribution"];
}

export interface DerivedChannel {
  source: string;
  medium: string;
  isPaid: boolean;
}

/**
 * Classifies a touch's channel from whatever attribution signal is
 * actually present in that event — never inferred beyond what's directly
 * observable (spec section 62: never invent, only capture/normalize what's
 * legitimately available).
 *
 * `fbclid`/`gclid` are Meta's and Google Ads' own click identifiers,
 * appended to the URL only when the visit came from clicking that
 * platform's ad: their presence is the one unambiguous "this is a paid
 * touch" signal available without requiring a UTM tag, so they are the
 * SOLE basis for `isPaid` here. A bare `utm_source=meta`/`utm_source=google`
 * with no click id is deliberately NOT treated as paid — that could just as
 * easily be an organic post someone tagged for tracking, and calling it
 * "paid" without the click id backing it up would be exactly the kind of
 * fabricated classification the spec prohibits. No Google Ads campaign is
 * live yet (Meta-only for now), but `gclid` is captured and classified the
 * same way `fbclid` always has been, so this function needs no changes
 * later when Google Ads actually starts sending traffic — see schema.ts's
 * `gclid` column comment for why capture starts before that campaign exists.
 *
 * Falls back to "referral" when there's a referrer with no UTM/click id,
 * and "direct" when there is no signal at all — the same three-bucket
 * shape as the spec's own worked example (Meta day 1 → Direct day 3 →
 * Meta day 5 → Purchase).
 */
export function deriveChannel(attribution: TrackingEventV1["attribution"]): DerivedChannel {
  if (attribution.fbclid) {
    return {
      source: attribution.utm_source ?? "meta",
      medium: attribution.utm_medium ?? "paid_social",
      isPaid: true,
    };
  }
  if (attribution.gclid) {
    return {
      source: attribution.utm_source ?? "google",
      medium: attribution.utm_medium ?? "cpc",
      isPaid: true,
    };
  }
  if (attribution.utm_source) {
    return { source: attribution.utm_source, medium: attribution.utm_medium ?? "unknown", isPaid: false };
  }
  if (attribution.referrer) {
    return { source: "referral", medium: "referral", isPaid: false };
  }
  return { source: "direct", medium: "direct", isPaid: false };
}

/**
 * Records one immutable attribution touch (docs/ARCHITECTURE.md section F —
 * "every ad-relevant visit becomes an independent, immutable touch, never
 * overwritten"). Called exactly once per NEW session (see the
 * `isNewSession` result from `upsertVisitorAndSession` in lib/identity.ts),
 * never once per event — a five-page browsing session is one touch, not
 * five, matching the spec's own example of distinct dated touches rather
 * than per-pageview noise.
 *
 * Also mirrors any `fbc`/`fbp` present into the Identity Graph as a
 * DETERMINISTIC edge to this session. docs/ARCHITECTURE.md section E lists
 * `fbc`/`fbp` <-> `session_id` as its own edge type specifically so a
 * lookup by cookie value (e.g. reconciling what Meta reports it matched
 * against what this session actually sent) doesn't require scanning every
 * `attribution_touches` row.
 */
export async function recordAttributionTouch(db: Database, input: TouchInput): Promise<void> {
  const channel = deriveChannel(input.attribution);

  await db.insert(schema.attributionTouches).values({
    trackingId: input.trackingId,
    sessionId: input.sessionId,
    source: channel.source,
    medium: channel.medium,
    campaign: input.attribution.utm_campaign,
    campaignId: input.attribution.campaign_id,
    adsetId: input.attribution.adset_id,
    adId: input.attribution.ad_id,
    fbclid: input.attribution.fbclid,
    fbc: input.attribution.fbc,
    fbp: input.attribution.fbp,
    gclid: input.attribution.gclid,
    landingPage: input.attribution.landing_page,
    referrer: input.attribution.referrer,
    isPaid: channel.isPaid,
  });

  const cookieEdges: Array<["fbc" | "fbp", string | undefined]> = [
    ["fbc", input.attribution.fbc],
    ["fbp", input.attribution.fbp],
  ];
  for (const [entityType, value] of cookieEdges) {
    if (!value) continue;
    await db
      .insert(schema.identityLinks)
      .values({
        entityAType: entityType,
        entityAValue: value,
        entityBType: "session_id",
        entityBValue: input.sessionId,
        confidence: "DETERMINISTIC",
        source: "pixel_cookie",
      })
      .onConflictDoNothing();
  }
}
