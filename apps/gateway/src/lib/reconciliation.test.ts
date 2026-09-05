import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase, schema, type Database } from "@tracking/db";
import type { Queue } from "bullmq";
import type { GatewayConfig } from "../config.js";
import { purchaseEventId } from "./metaCapiPurchase.js";
import { recordDeadLetter } from "./deadLetter.js";
import { createMetaCapiQueue, type MetaCapiJobData } from "./metaQueue.js";
import {
  ReconciliationCategory,
  requeueEligibleOrders,
  runReconciliation,
  scanMissingLocalOrders,
  scanPaidOrders,
  type ReconciliationOrderDetail,
} from "./reconciliation.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://tracking:tracking_dev_pw@localhost:5432/tracking_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";
const QUEUE_PREFIX = "test-reconciliation";

function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    TRACKING_ENV: "development",
    PORT: 3000,
    LOG_LEVEL: "info",
    DATABASE_URL: TEST_DATABASE_URL,
    GATEWAY_HMAC_SECRET: "a".repeat(32),
    CORS_ALLOWLIST: [],
    TRANSFER_TOKEN_TTL_SECONDS: 600,
    SHOPIFY_STORES: [],
    META_API_VERSION: "v23.0",
    META_QUEUE_ATTEMPTS: 5,
    META_QUEUE_BACKOFF_DELAY_MS: 5000,
    META_QUEUE_BACKOFF_JITTER: 0.2,
    RECONCILIATION_CRON: "*/30 * * * *",
    RECONCILIATION_STALE_AFTER_MINUTES: 15,
    RECONCILIATION_MAX_REQUEUE_ATTEMPTS: 3,
    RECONCILIATION_REQUEUE_COOLDOWN_MINUTES: 60,
    ...overrides,
  };
}

let db: Database;
let pool: ReturnType<typeof createDatabase>["pool"];

beforeAll(async () => {
  const created = createDatabase(TEST_DATABASE_URL);
  db = created.db;
  pool = created.pool;

  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db, { migrationsFolder: new URL("../../../../packages/db/migrations", import.meta.url).pathname });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE orders, event_registry, meta_deliveries, dead_letters, reconciliation_runs RESTART IDENTITY CASCADE",
  );
});

/** Minimal order row — enough for every reconciliation category, since
 * none of them depend on the full identity/journey chain (that machinery
 * is exercised by metaCapiPurchase.test.ts / metaWorker.test.ts already). */
async function seedOrder(params: {
  orderId: string;
  shopId?: string;
  currency?: string;
  totalAmount?: string;
  paidAt: Date;
}) {
  await db.insert(schema.orders).values({
    orderId: params.orderId,
    shopId: params.shopId ?? "store-b",
    currency: params.currency ?? "BRL",
    totalAmount: params.totalAmount ?? "199.90",
    state: "PAID",
    paidAt: params.paidAt,
  });
}

async function seedEventRegistry(eventId: string, metaSent: boolean) {
  await db.insert(schema.eventRegistry).values({
    eventId,
    eventName: "Purchase",
    trackingId: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    sourceOrigin: "server",
    metaSent,
  });
}

async function seedDelivery(eventId: string, opts: { currencySent?: string; valueSent?: string }) {
  await db.insert(schema.metaDeliveries).values({
    eventId,
    httpStatus: 200,
    responseRedacted: { events_received: 1 },
    attemptCount: 1,
    deliveryStatus: "delivered",
    currencySent: opts.currencySent ?? "BRL",
    valueSent: opts.valueSent ?? "199.90",
  });
}

function findDetail(details: ReconciliationOrderDetail[], orderId: string): ReconciliationOrderDetail | undefined {
  return details.find((d) => d.orderId === orderId);
}

describe("scanPaidOrders", () => {
  it("categorizes a successfully delivered order as MATCHED", async () => {
    await seedOrder({ orderId: "o_matched", paidAt: new Date() });
    const eventId = purchaseEventId("store-b", "o_matched");
    await seedEventRegistry(eventId, true);
    await seedDelivery(eventId, {});

    const details = await scanPaidOrders(db, baseConfig());
    expect(findDetail(details, "o_matched")?.category).toBe(ReconciliationCategory.Matched);
  });

  it("flags more than one delivered row for the same event_id as DUPLICATED", async () => {
    await seedOrder({ orderId: "o_dup", paidAt: new Date() });
    const eventId = purchaseEventId("store-b", "o_dup");
    await seedEventRegistry(eventId, true);
    await seedDelivery(eventId, {});
    await seedDelivery(eventId, {});

    const details = await scanPaidOrders(db, baseConfig());
    expect(findDetail(details, "o_dup")?.category).toBe(ReconciliationCategory.Duplicated);
  });

  it("flags a currency that no longer matches what was actually sent as CURRENCY_MISMATCH", async () => {
    await seedOrder({ orderId: "o_cur", currency: "USD", paidAt: new Date() });
    const eventId = purchaseEventId("store-b", "o_cur");
    await seedEventRegistry(eventId, true);
    await seedDelivery(eventId, { currencySent: "BRL" });

    const details = await scanPaidOrders(db, baseConfig());
    const detail = findDetail(details, "o_cur");
    expect(detail?.category).toBe(ReconciliationCategory.CurrencyMismatch);
    expect(detail?.detail).toContain("sent=BRL");
    expect(detail?.detail).toContain("current=USD");
  });

  it("flags a value that no longer matches what was actually sent as VALUE_MISMATCH", async () => {
    await seedOrder({ orderId: "o_val", totalAmount: "250.00", paidAt: new Date() });
    const eventId = purchaseEventId("store-b", "o_val");
    await seedEventRegistry(eventId, true);
    await seedDelivery(eventId, { valueSent: "199.90" });

    const details = await scanPaidOrders(db, baseConfig());
    expect(findDetail(details, "o_val")?.category).toBe(ReconciliationCategory.ValueMismatch);
  });

  it("categorizes a dead letter with a structural-gap reason as UNATTRIBUTED, not MISSING_META", async () => {
    await seedOrder({ orderId: "o_unattr", paidAt: new Date() });
    const eventId = purchaseEventId("store-b", "o_unattr");
    await recordDeadLetter(db, {
      queueName: "meta-capi-purchase",
      jobId: eventId,
      jobData: { orderId: "o_unattr", shopId: "store-b" },
      failureReason: "consent_not_granted",
      attemptsMade: 1,
    });

    const details = await scanPaidOrders(db, baseConfig());
    expect(findDetail(details, "o_unattr")?.category).toBe(ReconciliationCategory.Unattributed);
  });

  it("categorizes a dead letter from a real Meta CAPI error as MISSING_META", async () => {
    await seedOrder({ orderId: "o_meta_err", paidAt: new Date() });
    const eventId = purchaseEventId("store-b", "o_meta_err");
    await recordDeadLetter(db, {
      queueName: "meta-capi-purchase",
      jobId: eventId,
      jobData: { orderId: "o_meta_err", shopId: "store-b" },
      failureReason: "meta_capi_permanent_http_error_190",
      attemptsMade: 1,
    });

    const details = await scanPaidOrders(db, baseConfig());
    expect(findDetail(details, "o_meta_err")?.category).toBe(ReconciliationCategory.MissingMeta);
  });

  it("flags a paid order with no delivery attempt and no dead letter as MISSING_META once past the stale threshold", async () => {
    await seedOrder({ orderId: "o_stale", paidAt: new Date(Date.now() - 20 * 60_000) });

    const details = await scanPaidOrders(db, baseConfig({ RECONCILIATION_STALE_AFTER_MINUTES: 15 }));
    const detail = findDetail(details, "o_stale");
    expect(detail?.category).toBe(ReconciliationCategory.MissingMeta);
    expect(detail?.detail).toBe("no_delivery_attempt_recorded");
  });

  it("does NOT flag a recently paid order with nothing attempted yet — still legitimately in flight", async () => {
    await seedOrder({ orderId: "o_fresh", paidAt: new Date() });

    const details = await scanPaidOrders(db, baseConfig({ RECONCILIATION_STALE_AFTER_MINUTES: 15 }));
    expect(findDetail(details, "o_fresh")).toBeUndefined();
  });

  it("cleans up a stale dead_letters row once the order is later found to be MATCHED", async () => {
    await seedOrder({ orderId: "o_recovered", paidAt: new Date() });
    const eventId = purchaseEventId("store-b", "o_recovered");
    await recordDeadLetter(db, {
      queueName: "meta-capi-purchase",
      jobId: eventId,
      jobData: { orderId: "o_recovered", shopId: "store-b" },
      failureReason: "meta_capi_retryable_http_error_500",
      attemptsMade: 2,
    });
    await seedEventRegistry(eventId, true);
    await seedDelivery(eventId, {});

    const details = await scanPaidOrders(db, baseConfig());
    expect(findDetail(details, "o_recovered")?.category).toBe(ReconciliationCategory.Matched);

    const [deadLetterRow] = await pool
      .query("SELECT * FROM dead_letters WHERE job_id = $1", [eventId])
      .then((r) => r.rows);
    expect(deadLetterRow).toBeUndefined();
  });
});

describe("scanMissingLocalOrders", () => {
  it("flags a successfully-delivered Purchase whose order no longer exists locally", async () => {
    const eventId = purchaseEventId("store-b", "o_ghost");
    await seedEventRegistry(eventId, true);
    // Deliberately no `orders` row for "o_ghost".

    const details = await scanMissingLocalOrders(db);
    const detail = findDetail(details, "o_ghost");
    expect(detail?.category).toBe(ReconciliationCategory.MissingLocal);
    expect(detail?.shopId).toBe("store-b");
  });

  it("does not flag a delivered Purchase whose order row exists", async () => {
    await seedOrder({ orderId: "o_present", paidAt: new Date() });
    const eventId = purchaseEventId("store-b", "o_present");
    await seedEventRegistry(eventId, true);

    const details = await scanMissingLocalOrders(db);
    expect(findDetail(details, "o_present")).toBeUndefined();
  });
});

describe("runReconciliation", () => {
  it("persists a reconciliation_runs row whose counts match the returned details", async () => {
    await seedOrder({ orderId: "o_run_matched", paidAt: new Date() });
    const matchedEventId = purchaseEventId("store-b", "o_run_matched");
    await seedEventRegistry(matchedEventId, true);
    await seedDelivery(matchedEventId, {});

    await seedOrder({ orderId: "o_run_stale", paidAt: new Date(Date.now() - 20 * 60_000) });

    const { summary, details } = await runReconciliation(db, baseConfig({ RECONCILIATION_STALE_AFTER_MINUTES: 15 }));

    expect(summary.matched).toBe(details.filter((d) => d.category === ReconciliationCategory.Matched).length);
    expect(summary.missingMeta).toBe(details.filter((d) => d.category === ReconciliationCategory.MissingMeta).length);
    expect(summary.matched).toBeGreaterThanOrEqual(1);
    expect(summary.missingMeta).toBeGreaterThanOrEqual(1);

    const [row] = await pool
      .query("SELECT * FROM reconciliation_runs WHERE run_id = $1", [summary.runId])
      .then((r) => r.rows);
    expect(row.matched).toBe(summary.matched);
    expect(row.missing_meta).toBe(summary.missingMeta);
    expect(row.finished_at).not.toBeNull();
  });
});

describe("requeueEligibleOrders", () => {
  let queue: Queue<MetaCapiJobData>;

  afterEach(async () => {
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
  });

  it("requeues a MISSING_META order with no prior dead letter", async () => {
    queue = createMetaCapiQueue(baseConfig({ REDIS_URL: TEST_REDIS_URL }), { prefix: QUEUE_PREFIX })!;
    const details: ReconciliationOrderDetail[] = [
      { orderId: "o_requeue_fresh", shopId: "store-b", category: ReconciliationCategory.MissingMeta },
    ];

    const outcomes = await requeueEligibleOrders(db, queue, baseConfig(), details);
    expect(outcomes).toEqual([{ orderId: "o_requeue_fresh", shopId: "store-b", requeued: true }]);

    const job = await queue.getJob(purchaseEventId("store-b", "o_requeue_fresh"));
    expect(job?.data).toEqual({ orderId: "o_requeue_fresh", shopId: "store-b" });
  });

  it("requeues an UNATTRIBUTED order whose dead letter is past cooldown and under the attempt cap", async () => {
    queue = createMetaCapiQueue(baseConfig({ REDIS_URL: TEST_REDIS_URL }), { prefix: QUEUE_PREFIX })!;
    const eventId = purchaseEventId("store-b", "o_requeue_eligible");
    await recordDeadLetter(db, {
      queueName: "meta-capi-purchase",
      jobId: eventId,
      jobData: { orderId: "o_requeue_eligible", shopId: "store-b" },
      failureReason: "consent_not_granted",
      attemptsMade: 1,
    });
    await pool.query("UPDATE dead_letters SET last_failed_at = $1 WHERE job_id = $2", [
      new Date(Date.now() - 2 * 60 * 60_000),
      eventId,
    ]);

    const details: ReconciliationOrderDetail[] = [
      { orderId: "o_requeue_eligible", shopId: "store-b", category: ReconciliationCategory.Unattributed, detail: "consent_not_granted" },
    ];
    const outcomes = await requeueEligibleOrders(db, queue, baseConfig({ RECONCILIATION_REQUEUE_COOLDOWN_MINUTES: 60 }), details);
    expect(outcomes).toEqual([{ orderId: "o_requeue_eligible", shopId: "store-b", requeued: true }]);
  });

  it("does NOT requeue an order still within its cooldown window", async () => {
    queue = createMetaCapiQueue(baseConfig({ REDIS_URL: TEST_REDIS_URL }), { prefix: QUEUE_PREFIX })!;
    const eventId = purchaseEventId("store-b", "o_cooldown");
    await recordDeadLetter(db, {
      queueName: "meta-capi-purchase",
      jobId: eventId,
      jobData: { orderId: "o_cooldown", shopId: "store-b" },
      failureReason: "meta_capi_retryable_http_error_500",
      attemptsMade: 1,
    });

    const details: ReconciliationOrderDetail[] = [
      { orderId: "o_cooldown", shopId: "store-b", category: ReconciliationCategory.MissingMeta },
    ];
    const outcomes = await requeueEligibleOrders(db, queue, baseConfig({ RECONCILIATION_REQUEUE_COOLDOWN_MINUTES: 60 }), details);
    expect(outcomes).toEqual([{ orderId: "o_cooldown", shopId: "store-b", requeued: false, reason: "cooldown" }]);

    const job = await queue.getJob(eventId);
    expect(job).toBeUndefined();
  });

  it("does NOT requeue an order that already exhausted RECONCILIATION_MAX_REQUEUE_ATTEMPTS", async () => {
    queue = createMetaCapiQueue(baseConfig({ REDIS_URL: TEST_REDIS_URL }), { prefix: QUEUE_PREFIX })!;
    const eventId = purchaseEventId("store-b", "o_exhausted");
    await recordDeadLetter(db, {
      queueName: "meta-capi-purchase",
      jobId: eventId,
      jobData: { orderId: "o_exhausted", shopId: "store-b" },
      failureReason: "meta_capi_retryable_http_error_500",
      attemptsMade: 3,
    });
    await pool.query("UPDATE dead_letters SET last_failed_at = $1 WHERE job_id = $2", [
      new Date(Date.now() - 2 * 60 * 60_000),
      eventId,
    ]);

    const details: ReconciliationOrderDetail[] = [
      { orderId: "o_exhausted", shopId: "store-b", category: ReconciliationCategory.MissingMeta },
    ];
    const outcomes = await requeueEligibleOrders(
      db,
      queue,
      baseConfig({ RECONCILIATION_MAX_REQUEUE_ATTEMPTS: 3, RECONCILIATION_REQUEUE_COOLDOWN_MINUTES: 60 }),
      details,
    );
    expect(outcomes).toEqual([{ orderId: "o_exhausted", shopId: "store-b", requeued: false, reason: "max_attempts_reached" }]);
  });

  it("never touches MATCHED/DUPLICATED/*_MISMATCH categories", async () => {
    queue = createMetaCapiQueue(baseConfig({ REDIS_URL: TEST_REDIS_URL }), { prefix: QUEUE_PREFIX })!;
    const details: ReconciliationOrderDetail[] = [
      { orderId: "o_a", shopId: "store-b", category: ReconciliationCategory.Matched },
      { orderId: "o_b", shopId: "store-b", category: ReconciliationCategory.Duplicated },
      { orderId: "o_c", shopId: "store-b", category: ReconciliationCategory.ValueMismatch },
      { orderId: "o_d", shopId: "store-b", category: ReconciliationCategory.CurrencyMismatch },
      { orderId: "o_e", shopId: "store-b", category: ReconciliationCategory.MissingLocal },
    ];

    const outcomes = await requeueEligibleOrders(db, queue, baseConfig(), details);
    expect(outcomes).toEqual([]);
  });
});
