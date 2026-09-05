import { and, desc, eq } from "drizzle-orm";
import { schema, type Database } from "@tracking/db";
import type { TrackingEventV1 } from "@tracking/schema";

/**
 * Persists a consent snapshot (docs/ARCHITECTURE.md section I: "quatro
 * flags rastreadas por evento... consentimento por loja, não global").
 * `consent_states` is append-only by design (no unique key, no upsert) —
 * each snapshot is kept, not overwritten, so the *history* of a visitor's
 * consent choices within a shop stays reconstructable (e.g. for the data
 * rights / audit requirements in section 63), and "the current state" is
 * simply "the most recent row for this shop_id + session_id".
 *
 * Only writes a row when the event actually carries at least one consent
 * flag — most navigation events don't touch consent at all, and writing a
 * row of four `null`s on every single event would swamp the table and
 * would NOT mean "consent denied", it would mean "this event said
 * nothing about consent" — a very different, and important, distinction
 * (see `getCurrentMarketingConsent` below: absence of any row is treated
 * as "unknown", not as an implicit grant or denial).
 */
export async function recordConsentIfPresent(
  db: Database,
  params: { shopId: string; sessionId: string; consent: TrackingEventV1["consent"] },
): Promise<void> {
  const { consent } = params;
  const hasAnySignal =
    consent.analyticsProcessingAllowed !== undefined ||
    consent.marketingAllowed !== undefined ||
    consent.preferencesProcessingAllowed !== undefined ||
    consent.saleOfDataAllowed !== undefined;
  if (!hasAnySignal) return;

  await db.insert(schema.consentStates).values({
    shopId: params.shopId,
    sessionId: params.sessionId,
    analyticsProcessingAllowed: consent.analyticsProcessingAllowed ?? null,
    marketingAllowed: consent.marketingAllowed ?? null,
    preferencesProcessingAllowed: consent.preferencesProcessingAllowed ?? null,
    saleOfDataAllowed: consent.saleOfDataAllowed ?? null,
  });
}

export type MarketingConsentStatus = "granted" | "denied" | "unknown";

/**
 * The decision rule from docs/ARCHITECTURE.md section I, made explicit
 * and impossible to bypass by construction: "sem consentimento de
 * marketing, evento é registrado internamente mas não expedido ao Meta."
 * `"unknown"` (no consent snapshot recorded yet for this shop+session) is
 * treated the SAME as `"denied"` by every caller that gates a Meta send —
 * fail-closed. This is a stricter reading than "assume opted-in until told
 * otherwise", but it's the only reading consistent with never fabricating
 * a consent this system was never actually given.
 */
export async function getCurrentMarketingConsent(
  db: Database,
  params: { shopId: string; sessionId: string | null },
): Promise<MarketingConsentStatus> {
  if (!params.sessionId) return "unknown";

  const [latest] = await db
    .select({ marketingAllowed: schema.consentStates.marketingAllowed })
    .from(schema.consentStates)
    .where(
      and(
        eq(schema.consentStates.shopId, params.shopId),
        eq(schema.consentStates.sessionId, params.sessionId),
      ),
    )
    .orderBy(desc(schema.consentStates.recordedAt))
    .limit(1);

  if (!latest || latest.marketingAllowed === null) return "unknown";
  return latest.marketingAllowed ? "granted" : "denied";
}
