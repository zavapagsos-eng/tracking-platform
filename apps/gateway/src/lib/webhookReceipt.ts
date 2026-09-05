import { schema, type Database } from "@tracking/db";

export type RecordReceiptResult = { status: "new" } | { status: "duplicate" };

/**
 * Idempotency gate for webhook deliveries (spec section 43): Shopify may
 * redeliver the same webhook (retries, at-least-once delivery). Keyed on
 * `(shop_id, webhook_id)` — `X-Shopify-Webhook-Id` is a stable identifier
 * Shopify assigns per delivery attempt of the same logical event... in
 * practice Shopify reuses the same webhook_id across retries of one
 * delivery, which is exactly the property this relies on. First receipt
 * wins; every later one is recognized and short-circuited before any
 * business logic runs.
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

  return inserted.length > 0 ? { status: "new" } : { status: "duplicate" };
}
