import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { schema, type Database } from "@tracking/db";
import type { Queue } from "bullmq";
import type { GatewayConfig } from "../config.js";
import { purchaseEventId } from "./metaCapiPurchase.js";
import { deleteDeadLetter, getDeadLetter } from "./deadLetter.js";
import { enqueuePurchaseSend, META_CAPI_QUEUE_NAME, type MetaCapiJobData } from "./metaQueue.js";

/**
 * Reconciliation Engine (Phase 12, docs/ARCHITECTURE.md seção J: "compara
 * orders(financial_status=paid) × event_registry(event_name=Purchase,
 * meta_sent) × respostas do Meta, gerando categorias MATCHED /
 * MISSING_LOCAL / MISSING_META / DUPLICATED / VALUE_MISMATCH /
 * CURRENCY_MISMATCH / UNATTRIBUTED — nunca fabricando atribuição para
 * fechar a conta").
 *
 * IMPORTANT — documented scope boundary (not silently glossed over): this
 * compares Postgres against Postgres. It does NOT query Meta's own side
 * live — Meta does not expose a query API to list which CAPI events it
 * actually received/matched (Events Manager is a UI, and the Insights/
 * match-rate APIs report aggregate quality metrics, not a per-event
 * lookup by event_id). "respostas do Meta" here means this Gateway's own
 * durable record of what Meta's `/events` endpoint responded at send time
 * (`meta_deliveries`), which is the only honestly available signal — never
 * an invented cross-check against a Meta API that doesn't exist for this
 * purpose.
 */
export const ReconciliationCategory = {
  Matched: "MATCHED",
  MissingLocal: "MISSING_LOCAL",
  MissingMeta: "MISSING_META",
  Duplicated: "DUPLICATED",
  ValueMismatch: "VALUE_MISMATCH",
  CurrencyMismatch: "CURRENCY_MISMATCH",
  Unattributed: "UNATTRIBUTED",
} as const;
export type ReconciliationCategoryValue = (typeof ReconciliationCategory)[keyof typeof ReconciliationCategory];

/**
 * Every `SendPurchaseResult` status (see lib/metaCapiPurchase.ts) that
 * represents a structural/data gap rather than an actual Meta CAPI error —
 * these are exactly the statuses `lib/metaWorker.ts`'s processor writes
 * DIRECTLY to `dead_letters` (never via its `worker.on("failed",...)`
 * listener, which only ever fires for real Meta CAPI errors). A dead
 * letter whose `failure_reason` is one of these means "we never even
 * reached Meta" — reported as UNATTRIBUTED, distinct from MISSING_META
 * (which means Meta CAPI itself rejected the request, or nothing has been
 * attempted at all yet).
 */
const STRUCTURAL_GAP_REASONS = new Set<string>([
  "consent_not_granted",
  "order_not_found",
  "no_checkout_correlation",
  "checkout_not_tracked",
  "session_not_tracked",
]);

/** Order states that mean "this order was paid at some point" — the
 * candidate set this scan considers. `ORDER_CREATED` alone (never paid)
 * is excluded on purpose: there is nothing to reconcile against Meta for
 * an order that never became a Purchase. */
const PAID_ORDER_STATES = [
  "PAID",
  "PURCHASE_RECORDED",
  "META_DELIVERED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
] as const;

export interface ReconciliationOrderDetail {
  orderId: string;
  shopId: string;
  category: ReconciliationCategoryValue;
  /** Human-readable specifics — a dead-letter failure reason, the two
   * mismatched values, etc. Never required for the category itself to be
   * correct, only for a human (or the Phase 13 dashboard) to act on it. */
  detail?: string;
}

export interface ReconciliationSummary {
  runId: string;
  startedAt: Date;
  finishedAt: Date;
  matched: number;
  missingLocal: number;
  missingMeta: number;
  duplicated: number;
  valueMismatch: number;
  currencyMismatch: number;
  unattributed: number;
}

export interface ReconciliationResult {
  summary: ReconciliationSummary;
  details: ReconciliationOrderDetail[];
}

/** Parses `purchase:{shop_id}:{order_id}` back into its parts. Splits on
 * the FIRST remaining colon only — `shop_id` values in this project are
 * always simple slugs (see `SHOPIFY_STORES`, config.ts) that never contain
 * a colon, so any colon after the prefix belongs to the order id (Shopify
 * order ids are numeric strings in practice, but this is defensive rather
 * than assumed). Returns `undefined` for anything not shaped like a
 * Purchase event_id, rather than guessing. */
function parsePurchaseEventId(eventId: string): { shopId: string; orderId: string } | undefined {
  const prefix = "purchase:";
  if (!eventId.startsWith(prefix)) return undefined;
  const rest = eventId.slice(prefix.length);
  const separatorIndex = rest.indexOf(":");
  if (separatorIndex === -1) return undefined;
  return { shopId: rest.slice(0, separatorIndex), orderId: rest.slice(separatorIndex + 1) };
}

/**
 * Scans every paid order for its Meta CAPI delivery status. For each one:
 *
 * 1. `event_registry.meta_sent = true` → it was delivered at least once.
 *    More than one `delivered` row for the same event_id is DUPLICATED
 *    (should never happen given the dedup gate in `sendPurchaseToMeta`,
 *    but is exactly the kind of bug this engine exists to surface). A
 *    single delivered row whose `currency_sent`/`value_sent` snapshot
 *    disagrees with the CURRENT `orders` row is CURRENCY_MISMATCH/
 *    VALUE_MISMATCH. Otherwise MATCHED. Any stale `dead_letters` row for
 *    an order that got here is cleaned up — it already succeeded.
 * 2. Not yet delivered, but a `dead_letters` row exists → its
 *    `failure_reason` decides UNATTRIBUTED (structural gap) vs
 *    MISSING_META (an actual, still-unresolved Meta CAPI error).
 * 3. Not yet delivered and no dead letter either → still legitimately in
 *    flight UNLESS it's been paid for longer than
 *    `RECONCILIATION_STALE_AFTER_MINUTES`, in which case it fell through
 *    the cracks entirely (e.g. `REDIS_URL` was down when `orders/paid`
 *    tried its fail-open enqueue) and is flagged MISSING_META.
 */
export async function scanPaidOrders(
  db: Database,
  config: Pick<GatewayConfig, "RECONCILIATION_STALE_AFTER_MINUTES">,
  options: { since?: Date } = {},
): Promise<ReconciliationOrderDetail[]> {
  const conditions = [inArray(schema.orders.state, [...PAID_ORDER_STATES])];
  if (options.since) conditions.push(gte(schema.orders.paidAt, options.since));

  const paidOrders = await db
    .select()
    .from(schema.orders)
    .where(and(...conditions));

  const staleThresholdMs = config.RECONCILIATION_STALE_AFTER_MINUTES * 60_000;
  const now = Date.now();
  const details: ReconciliationOrderDetail[] = [];

  for (const order of paidOrders) {
    const eventId = purchaseEventId(order.shopId, order.orderId);

    const [registryRow] = await db
      .select()
      .from(schema.eventRegistry)
      .where(eq(schema.eventRegistry.eventId, eventId))
      .limit(1);

    if (registryRow?.metaSent) {
      await deleteDeadLetter(db, { queueName: META_CAPI_QUEUE_NAME, jobId: eventId });

      const deliveredRows = await db
        .select()
        .from(schema.metaDeliveries)
        .where(and(eq(schema.metaDeliveries.eventId, eventId), eq(schema.metaDeliveries.deliveryStatus, "delivered")))
        .orderBy(desc(schema.metaDeliveries.requestTs));

      if (deliveredRows.length > 1) {
        details.push({
          orderId: order.orderId,
          shopId: order.shopId,
          category: ReconciliationCategory.Duplicated,
          detail: `${deliveredRows.length} delivered meta_deliveries rows for one event_id`,
        });
        continue;
      }

      const latest = deliveredRows[0];
      if (latest?.currencySent && order.currency && latest.currencySent !== order.currency) {
        details.push({
          orderId: order.orderId,
          shopId: order.shopId,
          category: ReconciliationCategory.CurrencyMismatch,
          detail: `sent=${latest.currencySent} current=${order.currency}`,
        });
        continue;
      }
      // Same numeric(12,2) column type/precision on both sides (see the
      // column comment on `metaDeliveries.valueSent`), so a plain string
      // comparison is safe — Postgres formats both identically.
      if (latest?.valueSent && order.totalAmount && latest.valueSent !== order.totalAmount) {
        details.push({
          orderId: order.orderId,
          shopId: order.shopId,
          category: ReconciliationCategory.ValueMismatch,
          detail: `sent=${latest.valueSent} current=${order.totalAmount}`,
        });
        continue;
      }

      details.push({ orderId: order.orderId, shopId: order.shopId, category: ReconciliationCategory.Matched });
      continue;
    }

    const deadLetter = await getDeadLetter(db, { queueName: META_CAPI_QUEUE_NAME, jobId: eventId });
    if (deadLetter) {
      const category = STRUCTURAL_GAP_REASONS.has(deadLetter.failureReason)
        ? ReconciliationCategory.Unattributed
        : ReconciliationCategory.MissingMeta;
      details.push({ orderId: order.orderId, shopId: order.shopId, category, detail: deadLetter.failureReason });
      continue;
    }

    if (!order.paidAt || now - order.paidAt.getTime() < staleThresholdMs) continue; // still legitimately in flight

    details.push({
      orderId: order.orderId,
      shopId: order.shopId,
      category: ReconciliationCategory.MissingMeta,
      detail: "no_delivery_attempt_recorded",
    });
  }

  return details;
}

/**
 * The reverse direction: a Purchase this Gateway's own records say was
 * successfully delivered to Meta, for an `order_id` that no longer (or
 * never did) exist in the local `orders` table — a genuine local data
 * integrity gap (a bug, a botched manual data operation, or corruption),
 * never something `scanPaidOrders` above could find since it starts from
 * `orders` in the first place.
 */
export async function scanMissingLocalOrders(db: Database): Promise<ReconciliationOrderDetail[]> {
  const deliveredPurchases = await db
    .select({ eventId: schema.eventRegistry.eventId })
    .from(schema.eventRegistry)
    .where(and(eq(schema.eventRegistry.eventName, "Purchase"), eq(schema.eventRegistry.metaSent, true)));

  const details: ReconciliationOrderDetail[] = [];
  for (const { eventId } of deliveredPurchases) {
    const parsed = parsePurchaseEventId(eventId);
    if (!parsed) continue;

    const [order] = await db
      .select({ orderId: schema.orders.orderId })
      .from(schema.orders)
      .where(eq(schema.orders.orderId, parsed.orderId))
      .limit(1);

    if (!order) {
      details.push({
        orderId: parsed.orderId,
        shopId: parsed.shopId,
        category: ReconciliationCategory.MissingLocal,
        detail: "meta_sent_but_no_local_order_row",
      });
    }
  }
  return details;
}

/**
 * Runs a full reconciliation pass and persists a `reconciliation_runs`
 * summary row (docs/ARCHITECTURE.md's ER diagram) — purely read/detect,
 * no queue side effects, so this is safe to call from a read-only context
 * (the Phase 13 Admin Dashboard included) without risking an unbounded
 * requeue storm. See `requeueEligibleOrders` below for the separate,
 * bounded remediation step.
 */
export async function runReconciliation(
  db: Database,
  config: Pick<GatewayConfig, "RECONCILIATION_STALE_AFTER_MINUTES">,
  options: { since?: Date } = {},
): Promise<ReconciliationResult> {
  const startedAt = new Date();
  const details = [...(await scanPaidOrders(db, config, options)), ...(await scanMissingLocalOrders(db))];

  const counts = {
    matched: 0,
    missingLocal: 0,
    missingMeta: 0,
    duplicated: 0,
    valueMismatch: 0,
    currencyMismatch: 0,
    unattributed: 0,
  };
  for (const item of details) {
    switch (item.category) {
      case ReconciliationCategory.Matched:
        counts.matched += 1;
        break;
      case ReconciliationCategory.MissingLocal:
        counts.missingLocal += 1;
        break;
      case ReconciliationCategory.MissingMeta:
        counts.missingMeta += 1;
        break;
      case ReconciliationCategory.Duplicated:
        counts.duplicated += 1;
        break;
      case ReconciliationCategory.ValueMismatch:
        counts.valueMismatch += 1;
        break;
      case ReconciliationCategory.CurrencyMismatch:
        counts.currencyMismatch += 1;
        break;
      case ReconciliationCategory.Unattributed:
        counts.unattributed += 1;
        break;
    }
  }

  const finishedAt = new Date();
  const [run] = await db
    .insert(schema.reconciliationRuns)
    .values({ startedAt, finishedAt, ...counts })
    .returning();
  if (!run) throw new Error("Failed to persist reconciliation_runs row");

  return { summary: { runId: run.runId, startedAt, finishedAt, ...counts }, details };
}

export interface RequeueOutcome {
  orderId: string;
  shopId: string;
  requeued: boolean;
  reason?: string;
}

/**
 * Bounded, automatic remediation — deliberately separate from
 * `runReconciliation` so a plain scan never has a queue side effect.
 * Only MISSING_META and UNATTRIBUTED are candidates: resending a MATCHED/
 * DUPLICATED order would only create more duplicates, and a *_MISMATCH
 * needs a human to decide what "correct" even means here, not a retry.
 *
 * Bounded on two axes, per `RECONCILIATION_MAX_REQUEUE_ATTEMPTS`/
 * `RECONCILIATION_REQUEUE_COOLDOWN_MINUTES` (config.ts): never more than N
 * attempts for the same order (a permanently-broken one must eventually
 * surface to a human instead of retrying forever), and never sooner than
 * the cooldown since its last failure (avoid hammering Meta/the queue
 * every cron tick for something that just failed).
 *
 * Respects the jobId-reuse constraint documented in docs/PHASE_LOG.md
 * Phase 11: re-adding a job under a jobId still sitting in a terminal
 * BullMQ state (completed/failed) is a silent no-op that never actually
 * reprocesses — so the old job is explicitly removed first (harmless if
 * none exists under that id).
 */
export async function requeueEligibleOrders(
  db: Database,
  queue: Queue<MetaCapiJobData>,
  config: Pick<GatewayConfig, "RECONCILIATION_MAX_REQUEUE_ATTEMPTS" | "RECONCILIATION_REQUEUE_COOLDOWN_MINUTES">,
  details: ReconciliationOrderDetail[],
): Promise<RequeueOutcome[]> {
  const cooldownMs = config.RECONCILIATION_REQUEUE_COOLDOWN_MINUTES * 60_000;
  const now = Date.now();
  const outcomes: RequeueOutcome[] = [];

  for (const item of details) {
    if (item.category !== ReconciliationCategory.MissingMeta && item.category !== ReconciliationCategory.Unattributed) {
      continue;
    }

    const eventId = purchaseEventId(item.shopId, item.orderId);
    const deadLetter = await getDeadLetter(db, { queueName: META_CAPI_QUEUE_NAME, jobId: eventId });

    if (deadLetter) {
      if (deadLetter.attemptsMade >= config.RECONCILIATION_MAX_REQUEUE_ATTEMPTS) {
        outcomes.push({ orderId: item.orderId, shopId: item.shopId, requeued: false, reason: "max_attempts_reached" });
        continue;
      }
      if (now - deadLetter.lastFailedAt.getTime() < cooldownMs) {
        outcomes.push({ orderId: item.orderId, shopId: item.shopId, requeued: false, reason: "cooldown" });
        continue;
      }
    }

    await queue.remove(eventId).catch(() => undefined);
    await enqueuePurchaseSend(queue, { orderId: item.orderId, shopId: item.shopId });
    outcomes.push({ orderId: item.orderId, shopId: item.shopId, requeued: true });
  }

  return outcomes;
}
