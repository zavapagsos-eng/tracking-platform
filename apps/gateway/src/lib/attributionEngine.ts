import { type Database } from "@tracking/db";
import { reconstructJourneyByOrderId, type JourneyByOrderResult } from "./journey.js";
import { computeAllAttributionModels, type AttributionModelResults } from "./attributionModels.js";

export type OrderAttributionResult =
  | Exclude<JourneyByOrderResult, { status: "ok" }>
  | (Extract<JourneyByOrderResult, { status: "ok" }> & { models: AttributionModelResults });

/**
 * The composed "attribution reconciliation" step from
 * docs/ARCHITECTURE.md section B.9: `order_id -> checkout_token ->
 * session B -> [cross-domain edge] -> session A -> attribution touches ->
 * the four models`. This is as far as Phase 9 goes — it does NOT build the
 * Meta CAPI `user_data`/normalized payload (Phase 10) or decide which
 * `fbc`/`fbp` to send (that uses the most recent value in the journey,
 * independently of which attribution model "wins" here — the models
 * computed below are an analytical/reporting view, per section D, not an
 * input to what's sent to Meta).
 *
 * Only attaches `models` when the journey resolved (`status: "ok"`) — every
 * other status (order not found, no checkout correlation, checkout never
 * tracked, session never tracked) means there is no touch history to model
 * in the first place, so there is nothing to compute; the caller gets the
 * same explicit status `reconstructJourneyByOrderId` already produces
 * rather than a models object silently full of nulls that could be
 * mistaken for "this visitor really had zero touches".
 */
export async function computeOrderAttribution(db: Database, orderId: string): Promise<OrderAttributionResult> {
  const journey = await reconstructJourneyByOrderId(db, orderId);
  if (journey.status !== "ok") {
    return journey;
  }
  return { ...journey, models: computeAllAttributionModels(journey.journey.touches) };
}
