import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import { createDatabase, type Database } from "@tracking/db";
import { createHmac } from "node:crypto";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";
import { purchaseEventId } from "../lib/metaCapiPurchase.js";

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://tracking:tracking_dev_pw@localhost:5432/tracking_test";

const STORE_A_SECRET = "store-a-webhook-secret-test-only";
const STORE_B_SECRET = "store-b-webhook-secret-test-only";
// A third, distinct registered destination store (with its own secret) —
// deliberately NOT named "store-c", since that shop_id is used elsewhere in
// this suite to exercise the "genuinely unregistered store" 404 path. This
// proves the registry genuinely supports N>2 stores, not just the original
// two, per docs/PHASE_LOG.md's "Correção de Arquitetura — Multi-Loja de
// Destino".
const STORE_D_SECRET = "store-d-webhook-secret-test-only";
const HMAC_SECRET = "test-secret-at-least-32-characters-long!!";

const SHOPIFY_STORES_JSON = JSON.stringify([
  { shop_id: "store-a", domain: "store-a.example.com", role: "storefront", webhook_secret: STORE_A_SECRET },
  { shop_id: "store-b", domain: "store-b.example.com", role: "checkout", webhook_secret: STORE_B_SECRET },
  { shop_id: "store-d", domain: "store-d.example.com", role: "checkout", webhook_secret: STORE_D_SECRET },
]);

let db: Database;
let pool: ReturnType<typeof createDatabase>["pool"];
let app: FastifyInstance;

/** Signs a raw body the way Shopify signs Admin webhook deliveries:
 * base64(HMAC-SHA256(rawBody, clientSecret)) — see lib/shopifyWebhookAuth.ts. */
function shopifySign(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

function webhookPost(
  path: string,
  body: unknown,
  opts: { secret?: string; webhookId?: string; topic: string; signatureOverride?: string },
) {
  const raw = JSON.stringify(body);
  const signature = opts.signatureOverride ?? shopifySign(opts.secret ?? STORE_B_SECRET, raw);
  return app.inject({
    method: "POST",
    url: path,
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": signature,
      "x-shopify-webhook-id": opts.webhookId ?? "wh_1",
      "x-shopify-topic": opts.topic,
      "x-shopify-shop-domain": "store-b.example.com",
    },
    payload: raw,
  });
}

beforeAll(async () => {
  const created = createDatabase(TEST_DATABASE_URL);
  db = created.db;
  pool = created.pool;

  await pool.query(
    "DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
  );
  await migrate(db, {
    migrationsFolder: new URL("../../../../packages/db/migrations", import.meta.url).pathname,
  });

  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    GATEWAY_HMAC_SECRET: HMAC_SECRET,
    SHOPIFY_STORES: SHOPIFY_STORES_JSON,
  } as unknown as NodeJS.ProcessEnv);

  app = await buildServer({ db, config });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE orders, refunds, webhook_receipts, audit_logs, events, event_registry RESTART IDENTITY CASCADE",
  );
});

describe("Shopify webhook HMAC + idempotency", () => {
  it("rejects a request with an invalid signature and does not persist a receipt", async () => {
    const res = await webhookPost(
      "/webhooks/store-b/orders/create",
      { id: 123 },
      { topic: "orders/create", signatureOverride: "not-a-real-signature" },
    );
    expect(res.statusCode).toBe(401);

    const receipts = await pool.query("SELECT * FROM webhook_receipts");
    expect(receipts.rowCount).toBe(0);
  });

  it("rejects a shop_id that is not in the SHOPIFY_STORES registry with 404", async () => {
    // store-c is deliberately NOT registered in SHOPIFY_STORES_JSON above,
    // so this exercises the genuine "unregistered store" path — fail
    // closed rather than falling back to any other store's secret.
    const res = await webhookPost(
      "/webhooks/store-c/orders/create",
      { id: 123 },
      { topic: "orders/create" },
    );
    expect(res.statusCode).toBe(404);
  });

  it("accepts a validly signed webhook from a THIRD registered destination store, using its own secret (proves N>2 stores work)", async () => {
    const res = await webhookPost(
      "/webhooks/store-d/orders/create",
      {
        id: 5100,
        total_price_set: {
          shop_money: { amount: "40.00", currency_code: "BRL" },
          presentment_money: { amount: "40.00", currency_code: "BRL" },
        },
        created_at: new Date().toISOString(),
      },
      { topic: "orders/create", webhookId: "wh_store_d_1", secret: STORE_D_SECRET },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "processed" });

    const orders = await pool.query("SELECT * FROM orders WHERE order_id = '5100'");
    expect(orders.rowCount).toBe(1);
  });

  it("accepts a validly signed orders/create webhook and ingests the order", async () => {
    const res = await webhookPost(
      "/webhooks/store-b/orders/create",
      {
        id: 5001,
        checkout_token: "chk_abc",
        financial_status: "pending",
        total_price_set: {
          shop_money: { amount: "99.90", currency_code: "BRL" },
          presentment_money: { amount: "99.90", currency_code: "BRL" },
        },
        created_at: new Date().toISOString(),
      },
      { topic: "orders/create", webhookId: "wh_order_create_1" },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "processed" });

    const orders = await pool.query("SELECT * FROM orders WHERE order_id = '5001'");
    expect(orders.rowCount).toBe(1);
    expect(orders.rows[0].state).toBe("ORDER_CREATED");
    expect(orders.rows[0].checkout_token).toBe("chk_abc");
    expect(orders.rows[0].total_amount).toBe("99.90");
  });

  it("is idempotent: redelivering the same webhook_id is acknowledged without reprocessing", async () => {
    const payload = { id: 5002, created_at: new Date().toISOString() };
    const first = await webhookPost("/webhooks/store-b/orders/create", payload, {
      topic: "orders/create",
      webhookId: "wh_order_create_2",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ status: "processed" });

    const second = await webhookPost("/webhooks/store-b/orders/create", payload, {
      topic: "orders/create",
      webhookId: "wh_order_create_2",
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ status: "duplicate" });

    const receipts = await pool.query(
      "SELECT * FROM webhook_receipts WHERE webhook_id = 'wh_order_create_2'",
    );
    expect(receipts.rowCount).toBe(1);
  });

  it("transitions an order to PAID on orders/paid", async () => {
    await webhookPost(
      "/webhooks/store-b/orders/create",
      { id: 5003, total_price_set: { shop_money: { amount: "50.00", currency_code: "BRL" }, presentment_money: { amount: "50.00", currency_code: "BRL" } } },
      { topic: "orders/create", webhookId: "wh_5003_create" },
    );

    const res = await webhookPost(
      "/webhooks/store-b/orders/paid",
      { id: 5003, financial_status: "paid" },
      { topic: "orders/paid", webhookId: "wh_5003_paid" },
    );
    expect(res.statusCode).toBe(200);

    const orders = await pool.query("SELECT state, paid_at FROM orders WHERE order_id = '5003'");
    expect(orders.rows[0].state).toBe("PAID");
    expect(orders.rows[0].paid_at).not.toBeNull();
  });

  it("marks an order CANCELLED on orders/cancelled", async () => {
    await webhookPost("/webhooks/store-b/orders/create", { id: 5004 }, {
      topic: "orders/create",
      webhookId: "wh_5004_create",
    });

    const res = await webhookPost(
      "/webhooks/store-b/orders/cancelled",
      { id: 5004, cancelled_at: new Date().toISOString() },
      { topic: "orders/cancelled", webhookId: "wh_5004_cancel" },
    );
    expect(res.statusCode).toBe(200);

    const orders = await pool.query("SELECT state FROM orders WHERE order_id = '5004'");
    expect(orders.rows[0].state).toBe("CANCELLED");
  });

  it("records a full refund and marks the order REFUNDED", async () => {
    await webhookPost(
      "/webhooks/store-b/orders/create",
      { id: 5005, total_price_set: { shop_money: { amount: "80.00", currency_code: "BRL" }, presentment_money: { amount: "80.00", currency_code: "BRL" } } },
      { topic: "orders/create", webhookId: "wh_5005_create" },
    );

    const res = await webhookPost(
      "/webhooks/store-b/refunds/create",
      {
        id: 9001,
        order_id: 5005,
        created_at: new Date().toISOString(),
        transactions: [{ amount: "80.00" }],
      },
      { topic: "refunds/create", webhookId: "wh_5005_refund" },
    );
    expect(res.statusCode).toBe(200);

    const orders = await pool.query("SELECT state FROM orders WHERE order_id = '5005'");
    expect(orders.rows[0].state).toBe("REFUNDED");

    const refunds = await pool.query("SELECT * FROM refunds WHERE refund_id = '9001'");
    expect(refunds.rowCount).toBe(1);
  });

  it("records a partial refund and marks the order PARTIALLY_REFUNDED", async () => {
    await webhookPost(
      "/webhooks/store-b/orders/create",
      { id: 5006, total_price_set: { shop_money: { amount: "80.00", currency_code: "BRL" }, presentment_money: { amount: "80.00", currency_code: "BRL" } } },
      { topic: "orders/create", webhookId: "wh_5006_create" },
    );

    const res = await webhookPost(
      "/webhooks/store-b/refunds/create",
      { id: 9002, order_id: 5006, transactions: [{ amount: "20.00" }] },
      { topic: "refunds/create", webhookId: "wh_5006_refund" },
    );
    expect(res.statusCode).toBe(200);

    const orders = await pool.query("SELECT state FROM orders WHERE order_id = '5006'");
    expect(orders.rows[0].state).toBe("PARTIALLY_REFUNDED");
  });

  it("returns 400 for a validly signed but malformed order payload", async () => {
    const res = await webhookPost(
      "/webhooks/store-b/orders/create",
      { no_id_field: true },
      { topic: "orders/create", webhookId: "wh_malformed_1" },
    );
    expect(res.statusCode).toBe(400);
  });
});

describe("orders/paid enqueues the Meta CAPI Purchase send (Phase 11)", () => {
  let appWithQueue: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      GATEWAY_HMAC_SECRET: HMAC_SECRET,
      SHOPIFY_STORES: SHOPIFY_STORES_JSON,
      REDIS_URL: TEST_REDIS_URL,
    } as unknown as NodeJS.ProcessEnv);
    appWithQueue = await buildServer({ db, config });
  });

  afterAll(async () => {
    await appWithQueue.metaQueue?.obliterate({ force: true }).catch(() => undefined);
    await appWithQueue.close();
  });

  it("enqueues a job keyed by the deterministic purchase event_id after a successful orders/paid ingest", async () => {
    const raw = JSON.stringify({ id: 6001, financial_status: "paid", created_at: new Date().toISOString() });
    const signature = shopifySign(STORE_B_SECRET, raw);
    const res = await appWithQueue.inject({
      method: "POST",
      url: "/webhooks/store-b/orders/paid",
      headers: {
        "content-type": "application/json",
        "x-shopify-hmac-sha256": signature,
        "x-shopify-webhook-id": "wh_6001_paid",
        "x-shopify-topic": "orders/paid",
        "x-shopify-shop-domain": "store-b.example.com",
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);

    expect(appWithQueue.metaQueue).toBeDefined();
    const job = await appWithQueue.metaQueue?.getJob(purchaseEventId("store-b", "6001"));
    expect(job).toBeDefined();
    expect(job?.data).toEqual({ orderId: "6001", shopId: "store-b" });
  });
});

describe("Shopify GDPR mandatory webhooks", () => {
  it("acknowledges customers/data_request and writes an audit log without persisting PII", async () => {
    const res = await webhookPost(
      "/webhooks/store-a/customers/data_request",
      {
        shop_id: 1,
        shop_domain: "store-a.example.com",
        customer: { id: 555, email: "shopper@example.com", phone: "+15551234567" },
        orders_requested: [5001],
      },
      { topic: "customers/data_request", secret: STORE_A_SECRET, webhookId: "wh_gdpr_1" },
    );
    expect(res.statusCode).toBe(200);

    const logs = await pool.query(
      "SELECT * FROM audit_logs WHERE action = 'customers/data_request'",
    );
    expect(logs.rowCount).toBe(1);
    expect(logs.rows[0].entity_id).toBe("555");
    // The audit trail records the customer id, never the email/phone Shopify
    // included in the payload (spec section 25: PII stays out of anything
    // that isn't the dedicated, access-controlled data vault).
    expect(JSON.stringify(logs.rows[0].metadata_redacted)).not.toContain("shopper@example.com");
  });

  it("acknowledges customers/redact", async () => {
    const res = await webhookPost(
      "/webhooks/store-a/customers/redact",
      { shop_id: 1, customer: { id: 556 }, orders_to_redact: [5002] },
      { topic: "customers/redact", secret: STORE_A_SECRET, webhookId: "wh_gdpr_2" },
    );
    expect(res.statusCode).toBe(200);

    const logs = await pool.query("SELECT * FROM audit_logs WHERE action = 'customers/redact'");
    expect(logs.rowCount).toBe(1);
  });

  it("acknowledges shop/redact", async () => {
    const res = await webhookPost(
      "/webhooks/store-a/shop/redact",
      { shop_id: 1, shop_domain: "store-a.example.com" },
      { topic: "shop/redact", secret: STORE_A_SECRET, webhookId: "wh_gdpr_3" },
    );
    expect(res.statusCode).toBe(200);

    const logs = await pool.query("SELECT * FROM audit_logs WHERE action = 'shop/redact'");
    expect(logs.rowCount).toBe(1);
    expect(logs.rows[0].entity_id).toBe("store-a.example.com");
  });
});
