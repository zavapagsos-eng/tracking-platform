import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@tracking/db";

export type RecordReceiptResult = { status: "new" } | { status: "retry" } | { status: "duplicate" };

/**
 * Idempotency gate for webhook deliveries (spec section 43): Shopify may
 * redeliver the same webhook (retries, at-least-once delivery), reusing the
 * same `X-Shopify-Webhook-Id` across retries of one delivery. Keyed on
 * `(shop_id, webhook_id)`.
 *
 * A delivery only counts as a duplicate once an earlier one was fully
 * processed (`processing_status = 'processed'`, set by
 * `markWebhookProcessed`). If the earlier attempt failed part-way (a
 * transient DB error, a payload that failed validation), its receipt is
 * still `received` and the redelivery is reported as `retry` so the caller
 * runs the business logic again — instead of acknowledging it as a
 * duplicate and losing the order for good. Ingestion is idempotent on
 * `order_id`/`refund_id`, so running it again is safe.
 */
export async function recordWebhookReceipt(
  db: Database,
  params: { shopId: string; topic: string; webhookId: string; hmacValid: boolean },
): Promise<RecordReceiptResult> {
  const inserted = await db
    .insert(schema.webhookReceipts)
    .values({
      shopId: params.shopId,
      topic: params.topic,
      webhookId: params.webhookId,
      hmacValid: params.hmacValid,
      processingStatus: "received",
    })
    .onConflictDoNothing({
      target: [schema.webhookReceipts.shopId, schema.webhookReceipts.webhookId],
    })
    .returning({ receiptId: schema.webhookReceipts.receiptId });

  if (inserted.length > 0) return { status: "new" };

  const [existing] = await db
    .select({ processingStatus: schema.webhookReceipts.processingStatus })
    .from(schema.webhookReceipts)
    .where(
      and(eq(schema.webhookReceipts.shopId, params.shopId), eq(schema.webhookReceipts.webhookId, params.webhookId)),
    )
    .limit(1);

  return existing?.processingStatus === "processed" ? { status: "duplicate" } : { status: "retry" };
}

/** Marks a delivery as fully processed, so later redeliveries of the same
 * webhook_id are acknowledged without running the business logic again. */
export async function markWebhookProcessed(
  db: Database,
  params: { shopId: string; webhookId: string },
): Promise<void> {
  await db
    .update(schema.webhookReceipts)
    .set({ processingStatus: "processed" })
    .where(
      and(eq(schema.webhookReceipts.shopId, params.shopId), eq(schema.webhookReceipts.webhookId, params.webhookId)),
    );
}
