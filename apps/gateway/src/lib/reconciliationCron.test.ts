import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase, schema, type Database } from "@tracking/db";
import type { Queue } from "bullmq";
import type { GatewayConfig } from "../config.js";
import { purchaseEventId } from "./metaCapiPurchase.js";
import { createMetaCapiQueue, type MetaCapiJobData } from "./metaQueue.js";
import { runReconciliationCycle } from "./reconciliationCron.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://tracking:tracking_dev_pw@localhost:5432/tracking_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";
const QUEUE_PREFIX = "test-reconciliation-cron";

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
  await pool.query("TRUNCATE orders, event_registry, meta_deliveries, dead_letters, reconciliation_runs RESTART IDENTITY CASCADE");
});

describe("runReconciliationCycle", () => {
  it("scans but skips requeue (0) when no queue is configured", async () => {
    await db.insert(schema.orders).values({
      orderId: "o_no_queue",
      shopId: "store-b",
      currency: "BRL",
      totalAmount: "10.00",
      state: "PAID",
      paidAt: new Date(Date.now() - 20 * 60_000),
    });

    const outcome = await runReconciliationCycle(db, undefined, baseConfig());
    expect(outcome.result.summary.missingMeta).toBeGreaterThanOrEqual(1);
    expect(outcome.requeuedCount).toBe(0);
  });

  it("scans and requeues eligible orders when a queue is configured", async () => {
    await db.insert(schema.orders).values({
      orderId: "o_with_queue",
      shopId: "store-b",
      currency: "BRL",
      totalAmount: "10.00",
      state: "PAID",
      paidAt: new Date(Date.now() - 20 * 60_000),
    });

    const config = baseConfig({ REDIS_URL: TEST_REDIS_URL });
    const queue: Queue<MetaCapiJobData> = createMetaCapiQueue(config, { prefix: QUEUE_PREFIX })!;
    try {
      const outcome = await runReconciliationCycle(db, queue, config);
      expect(outcome.requeuedCount).toBe(1);

      const job = await queue.getJob(purchaseEventId("store-b", "o_with_queue"));
      expect(job?.data).toEqual({ orderId: "o_with_queue", shopId: "store-b" });
    } finally {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
  });
});
