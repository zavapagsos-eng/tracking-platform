import { eq } from "drizzle-orm";
import { schema, type Database } from "@tracking/db";
import type { TrackingEventV1 } from "@tracking/schema";

/**
 * Persists the `session_id <-> checkout_token` correlation the instant
 * Store B's Web Pixel observes `checkout_started` (docs/ARCHITECTURE.md
 * section E: this is what lets Order -> Attribution reconciliation, Phase
 * 9, walk backwards from an `order_id` to the session/tracking_id that
 * started it).
 *
 * Deliberately built here, at ingestion time, and NOT reconstructed later
 * from the Order webhook: the webhook only ever carries the token itself
 * (see lib/orderIngestion.ts), never which session started that checkout
 * — only the Web Pixel, which was actually there, knows that mapping. If
 * this insert never happens for a given `checkout_token` (ad blocker, JS
 * disabled, consent declined, or the pixel firing after the customer
 * already left), that checkout is genuinely untracked and Phase 9 must
 * treat it as `UNATTRIBUTED_CROSS_DOMAIN` rather than have this function
 * invent a session for it.
 */
export async function recordCheckoutStart(
  db: Database,
  params: { sessionId: string; shopId: string; event: TrackingEventV1 },
): Promise<void> {
  const checkoutToken = params.event.commerce.checkout_token;
  if (!checkoutToken) return;

  await db
    .insert(schema.checkouts)
    .values({
      checkoutToken,
      sessionId: params.sessionId,
      cartToken: params.event.commerce.cart_token,
      shopId: params.shopId,
      currency: params.event.commerce.currency,
      presentmentCurrency: params.event.commerce.presentment_currency,
    })
    .onConflictDoNothing({ target: schema.checkouts.checkoutToken });
}

export type ResolveCheckoutSessionResult =
  | { status: "checkout_not_tracked" }
  | { status: "session_not_tracked"; sessionId: string }
  | { status: "ok"; sessionId: string; trackingId: string };

/**
 * The `checkout_token -> session_id -> tracking_id` half of the chain
 * `reconstructJourneyByOrderId` (lib/journey.ts) and `ingestOrderWebhook`
 * (lib/orderIngestion.ts, Phase 10) both need — factored out here, next to
 * where the `checkouts` row is written, rather than duplicated in both
 * callers. Each broken link (no `checkouts` row for this token, or a
 * `checkouts` row whose `session_id` isn't itself a known session) is its
 * own named status rather than a thrown error — both are legitimate,
 * expected "not tracked" outcomes (see `recordCheckoutStart` above), not
 * bugs.
 */
export async function resolveSessionForCheckoutToken(
  db: Database,
  checkoutToken: string,
): Promise<ResolveCheckoutSessionResult> {
  const [checkout] = await db
    .select()
    .from(schema.checkouts)
    .where(eq(schema.checkouts.checkoutToken, checkoutToken))
    .limit(1);
  if (!checkout || !checkout.sessionId) return { status: "checkout_not_tracked" };

  const [session] = await db
    .select({ trackingId: schema.sessions.trackingId })
    .from(schema.sessions)
    .where(eq(schema.sessions.sessionId, checkout.sessionId))
    .limit(1);
  if (!session) return { status: "session_not_tracked", sessionId: checkout.sessionId };

  return { status: "ok", sessionId: checkout.sessionId, trackingId: session.trackingId };
}
