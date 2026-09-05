import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { schema } from "@tracking/db";
import { verifyShopifyWebhookHmac } from "../lib/shopifyWebhookAuth.js";
import { recordWebhookReceipt } from "../lib/webhookReceipt.js";
import {
  ingestOrderWebhook,
  ingestRefundWebhook,
  parseOrderWebhookPayload,
  parseRefundWebhookPayload,
  OrderWebhookTopic,
  type OrderWebhookPayload,
} from "../lib/orderIngestion.js";
import { enqueuePurchaseSend } from "../lib/metaQueue.js";
import { findStoreByShopId } from "../config.js";

/**
 * Shopify Admin API webhook subscriptions are configured per store, each
 * with its own signing secret. The route path carries which store sent the
 * delivery (`/webhooks/:store/*`, where `:store` is any `shop_id` in the
 * `SHOPIFY_STORES` registry — NOT a fixed "store-a"/"store-b" pair; a Hub
 * can have several destination/checkout stores, each installing this app
 * and getting its own webhook secret, see docs/PHASE_LOG.md's "Correção de
 * Arquitetura — Multi-Loja de Destino") so the correct secret is picked
 * before HMAC verification — never a single shared secret across stores
 * (spec section 6/59: per-domain treatment, never assumed shared).
 *
 * `orders/*`/`refunds/*` are expected from whichever stores have
 * `role: "checkout"` in the registry, but this route does not itself
 * enforce that distinction (Shopify only ever sends order/refund webhooks
 * from a store's own Admin in the first place) — any registered shop_id is
 * accepted on any topic. The GDPR mandatory webhooks
 * (`customers/data_request`, `customers/redact`, `shop/redact`) fire for
 * ANY store the app is installed on, storefront or checkout alike.
 */
interface AuthorizedWebhook {
  store: string;
  webhookId: string;
  topic: string;
}

/**
 * Verifies the store param is a registered shop_id, the per-store secret
 * from that registry entry, and the `X-Shopify-Hmac-Sha256` signature over
 * the exact raw body — in that order, so an unregistered store never
 * leaks whether a signature would have been valid.
 *
 * Deliberately does NOT call `recordWebhookReceipt` for a request that
 * fails HMAC verification: the idempotency ledger is keyed on
 * `(shop_id, webhook_id)`, and persisting an entry for an unauthenticated
 * request would let an attacker who captures/replays a real
 * `X-Shopify-Webhook-Id` (e.g. a tampered replay) occupy that slot ahead
 * of the genuine delivery — turning a rejected forgery into a dropped
 * real webhook. Only a request that passes HMAC ever touches the ledger.
 */
async function authorizeWebhook(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthorizedWebhook | undefined> {
  const { store } = request.params as { store: string };
  const storeEntry = findStoreByShopId(app.config, store);
  if (!storeEntry) {
    await reply.code(404).send({ error: "unknown_store" });
    return undefined;
  }

  const signature = request.headers["x-shopify-hmac-sha256"];
  const webhookId = request.headers["x-shopify-webhook-id"];
  const topic = request.headers["x-shopify-topic"];
  if (typeof signature !== "string" || typeof webhookId !== "string" || typeof topic !== "string") {
    await reply.code(400).send({ error: "missing_required_headers" });
    return undefined;
  }

  const rawBody = request.rawBody ?? "";
  if (!verifyShopifyWebhookHmac(rawBody, signature, storeEntry.webhook_secret)) {
    await reply.code(401).send({ error: "invalid_hmac" });
    return undefined;
  }

  return { store, webhookId, topic };
}

/**
 * Runs after `authorizeWebhook` succeeds: records the idempotency receipt
 * and reports whether this is a first delivery or a Shopify redelivery of
 * one already processed (spec section 43). Callers short-circuit on
 * `duplicate` — Shopify redeliveries must be acknowledged (200) without
 * re-running business logic a second time.
 */
async function checkIdempotency(
  app: FastifyInstance,
  auth: AuthorizedWebhook,
): Promise<"new" | "duplicate"> {
  const result = await recordWebhookReceipt(app.db, {
    shopId: auth.store,
    topic: auth.topic,
    webhookId: auth.webhookId,
    hmacValid: true,
  });
  return result.status;
}

/** Loose, defensive schemas for the three GDPR mandatory compliance
 * webhooks (spec section 63) — only the identifiers needed to route/audit
 * the request are extracted. Full payload shapes per
 * shopify.dev/docs/apps/build/privacy-law-compliance; fields beyond ids
 * (customer email/phone, order ids) are deliberately NOT persisted here —
 * see the module-level comment on `recordGdprAudit` for why. */
const customersDataRequestSchema = z.object({
  shop_id: z.union([z.number(), z.string()]).optional(),
  shop_domain: z.string().optional(),
  customer: z.object({ id: z.union([z.number(), z.string()]).transform(String).optional() }).optional(),
  orders_requested: z.array(z.union([z.number(), z.string()])).optional(),
});

const customersRedactSchema = z.object({
  shop_id: z.union([z.number(), z.string()]).optional(),
  shop_domain: z.string().optional(),
  customer: z.object({ id: z.union([z.number(), z.string()]).transform(String).optional() }).optional(),
  orders_to_redact: z.array(z.union([z.number(), z.string()])).optional(),
});

const shopRedactSchema = z.object({
  shop_id: z.union([z.number(), z.string()]).optional(),
  shop_domain: z.string().optional(),
});

/**
 * Writes an immutable audit trail entry for a GDPR mandatory webhook
 * delivery — proof the request was received and acknowledged within
 * Shopify's compliance window (spec section 41/63). Only identifiers are
 * stored (customer_id, order ids, shop domain) — never the customer's
 * email/phone/name, even though Shopify includes them in the payload for
 * `customers/data_request`/`customers/redact`, to avoid the audit log
 * itself becoming a second copy of the PII it is auditing the handling of.
 *
 * IMPORTANT — documented scope boundary (not silently glossed over):
 * this Phase 7 handler acknowledges the webhook (satisfies Shopify's "you
 * must respond" requirement) and records that the request occurred. It
 * does NOT yet execute the actual data export/erasure — that requires the
 * Identity Graph (Phase 8) to resolve a Shopify `customer.id` to the
 * `tracking_id`(s)/session(s)/events it maps to, plus a dedicated data-vault
 * purge routine. Tracked as an explicit pending item in
 * docs/PHASE_LOG.md Phase 7 rather than faked here.
 */
async function recordGdprAudit(
  app: FastifyInstance,
  params: { action: string; store: string; entity: string; entityId: string | undefined },
): Promise<void> {
  await app.db.insert(schema.auditLogs).values({
    actor: "shopify_webhook",
    action: params.action,
    entity: params.entity,
    entityId: params.entityId ?? null,
    metadataRedacted: { store: params.store },
  });
}

/**
 * Runs the parse+ingest step for an order/refund webhook, translating a
 * payload validation failure into a 400 rather than an uncaught 500 —
 * Shopify's payload shape is externally controlled, so a malformed body
 * (schema drift, an API version this Gateway hasn't been updated for) is
 * an expected failure mode, not a bug. Returns `true` if the response has
 * already been sent (validation failed) so the caller skips its own 200.
 */
async function tryIngest(reply: FastifyReply, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (err) {
    if (err instanceof ZodError) {
      await reply.code(400).send({ error: "invalid_webhook_payload", details: err.issues });
      return true;
    }
    throw err;
  }
}

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { store: string } }>("/webhooks/:store/orders/create", async (request, reply) => {
    const auth = await authorizeWebhook(app, request, reply);
    if (!auth) return;
    if ((await checkIdempotency(app, auth)) === "duplicate") {
      return reply.code(200).send({ status: "duplicate" });
    }

    const failed = await tryIngest(reply, async () => {
      const payload = parseOrderWebhookPayload(request.body);
      await ingestOrderWebhook(app.db, { shopId: auth.store, topic: OrderWebhookTopic.Create, payload });
    });
    if (failed) return;
    return reply.code(200).send({ status: "processed" });
  });

  // The Purchase-confirmation trigger (spec section 8/24; resolves the
  // "a fixar na Fase 7" note in docs/ARCHITECTURE.md): `orders/paid` is
  // used as the authoritative "this order is paid" signal rather than
  // `orders/create` + a `financial_status` check on that payload. Per
  // Shopify's documented webhook behavior, `orders/paid` fires whenever an
  // order's financial_status transitions to `paid`/`partially_paid` —
  // including orders paid at creation time (Shopify still fires BOTH
  // `orders/create` and `orders/paid` for those), so this is not lossy.
  // Orders captured manually or in installments require explicit,
  // configurable handling this Gateway does not yet implement — flagged
  // as an open item in docs/PHASE_LOG.md rather than assumed away.
  app.post<{ Params: { store: string } }>("/webhooks/:store/orders/paid", async (request, reply) => {
    const auth = await authorizeWebhook(app, request, reply);
    if (!auth) return;
    if ((await checkIdempotency(app, auth)) === "duplicate") {
      return reply.code(200).send({ status: "duplicate" });
    }

    let payload: OrderWebhookPayload | undefined;
    const failed = await tryIngest(reply, async () => {
      payload = parseOrderWebhookPayload(request.body);
      await ingestOrderWebhook(app.db, { shopId: auth.store, topic: OrderWebhookTopic.Paid, payload });
    });
    if (failed) return;

    // Fail-open, per docs/ARCHITECTURE.md section J: enqueueing the Meta
    // CAPI send is best-effort and must never turn a successfully-ingested
    // order into a failed webhook delivery. `app.metaQueue` is `undefined`
    // when REDIS_URL isn't configured (Phase 11 queueing not wired up in
    // this environment yet) — logged, not thrown. If enqueueing itself
    // throws (e.g. Redis briefly unreachable), the order is still recorded
    // locally and will be picked up by the Reconciliation Engine (Phase 12).
    if (app.metaQueue && payload) {
      try {
        await enqueuePurchaseSend(app.metaQueue, { orderId: payload.id, shopId: auth.store });
      } catch (err) {
        request.log.error({ err, orderId: payload.id }, "failed to enqueue Purchase send to Meta CAPI");
      }
    }

    return reply.code(200).send({ status: "processed" });
  });

  app.post<{ Params: { store: string } }>("/webhooks/:store/orders/cancelled", async (request, reply) => {
    const auth = await authorizeWebhook(app, request, reply);
    if (!auth) return;
    if ((await checkIdempotency(app, auth)) === "duplicate") {
      return reply.code(200).send({ status: "duplicate" });
    }

    const failed = await tryIngest(reply, async () => {
      const payload = parseOrderWebhookPayload(request.body);
      await ingestOrderWebhook(app.db, { shopId: auth.store, topic: OrderWebhookTopic.Cancelled, payload });
    });
    if (failed) return;
    return reply.code(200).send({ status: "processed" });
  });

  app.post<{ Params: { store: string } }>("/webhooks/:store/refunds/create", async (request, reply) => {
    const auth = await authorizeWebhook(app, request, reply);
    if (!auth) return;
    if ((await checkIdempotency(app, auth)) === "duplicate") {
      return reply.code(200).send({ status: "duplicate" });
    }

    const failed = await tryIngest(reply, async () => {
      const payload = parseRefundWebhookPayload(request.body);
      await ingestRefundWebhook(app.db, { shopId: auth.store, payload });
    });
    if (failed) return;
    return reply.code(200).send({ status: "processed" });
  });

  app.post<{ Params: { store: string } }>(
    "/webhooks/:store/customers/data_request",
    async (request, reply) => {
      const auth = await authorizeWebhook(app, request, reply);
      if (!auth) return;
      if ((await checkIdempotency(app, auth)) === "duplicate") {
        return reply.code(200).send({ status: "duplicate" });
      }

      const parsed = customersDataRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request_body" });
      }
      await recordGdprAudit(app, {
        action: "customers/data_request",
        store: auth.store,
        entity: "customer",
        entityId: parsed.data.customer?.id,
      });
      return reply.code(200).send({ status: "processed" });
    },
  );

  app.post<{ Params: { store: string } }>("/webhooks/:store/customers/redact", async (request, reply) => {
    const auth = await authorizeWebhook(app, request, reply);
    if (!auth) return;
    if ((await checkIdempotency(app, auth)) === "duplicate") {
      return reply.code(200).send({ status: "duplicate" });
    }

    const parsed = customersRedactSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request_body" });
    }
    await recordGdprAudit(app, {
      action: "customers/redact",
      store: auth.store,
      entity: "customer",
      entityId: parsed.data.customer?.id,
    });
    return reply.code(200).send({ status: "processed" });
  });

  app.post<{ Params: { store: string } }>("/webhooks/:store/shop/redact", async (request, reply) => {
    const auth = await authorizeWebhook(app, request, reply);
    if (!auth) return;
    if ((await checkIdempotency(app, auth)) === "duplicate") {
      return reply.code(200).send({ status: "duplicate" });
    }

    const parsed = shopRedactSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request_body" });
    }
    await recordGdprAudit(app, {
      action: "shop/redact",
      store: auth.store,
      entity: "shop",
      entityId: parsed.data.shop_domain ?? (parsed.data.shop_id !== undefined ? String(parsed.data.shop_id) : undefined),
    });
    return reply.code(200).send({ status: "processed" });
  });
}
