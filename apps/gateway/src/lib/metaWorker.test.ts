import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase, schema, type Database } from "@tracking/db";
import type { Queue, Worker } from "bullmq";
import { upsertVisitorAndSession } from "./identity.js";
import { recordAttributionTouch } from "./attribution.js";
import { recordCheckoutStart } from "./checkoutTracking.js";
import { recordConsentIfPresent } from "./consent.js";
import { backfillCustomerIdentityFromOrder, parseOrderWebhookPayload } from "./orderIngestion.js";
import { purchaseEventId } from "./metaCapiPurchase.js";
import { createMetaCapiQueue, enqueuePurchaseSend, type MetaCapiJobData } from "./metaQueue.js";
import { createMetaCapiWorker } from "./metaWorker.js";
import type { TrackingEventV1 } from "@tracking/schema";
import type { GatewayConfig } from "../config.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://tracking:tracking_dev_pw@localhost:5432/tracking_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";
const QUEUE_PREFIX = "test-metaworker";

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
    REDIS_URL: TEST_REDIS_URL,
    META_ACCESS_TOKEN: "test-access-token",
    META_DATASET_ID: "1234567890",
    META_API_VERSION: "v23.0",
    // Small values so the retry-exhaustion tests below run in well under a
    // second instead of waiting out a production-sized exponential backoff.
    META_QUEUE_ATTEMPTS: 2,
    META_QUEUE_BACKOFF_DELAY_MS: 20,
    META_QUEUE_BACKOFF_JITTER: 0,
    RECONCILIATION_CRON: "*/30 * * * *",
    RECONCILIATION_STALE_AFTER_MINUTES: 15,
    RECONCILIATION_MAX_REQUEUE_ATTEMPTS: 5,
    RECONCILIATION_REQUEUE_COOLDOWN_MINUTES: 60,
    ...overrides,
  };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 5000, intervalMs = 40): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error("waitFor: timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
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
    "TRUNCATE identity_links, identity_private, attribution_touches, checkouts, orders, consent_states, event_registry, meta_deliveries, dead_letters, sessions, visitors RESTART IDENTITY CASCADE",
  );
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Same cross-domain seed shape as metaCapiPurchase.test.ts's `seedFullOrder` —
 * duplicated locally rather than imported, since it is test-only fixture
 * setup, not shared production code. */
async function seedFullOrder(orderId: string, checkoutToken: string, opts: { grantConsent: boolean }) {
  const trackingIdA = uuid(100 + orderId.length);
  const sessionIdA = uuid(200 + orderId.length);
  const trackingIdB = uuid(300 + orderId.length);
  const sessionIdB = uuid(400 + orderId.length);

  await upsertVisitorAndSession(db, { trackingId: trackingIdA, sessionId: sessionIdA, shopId: "store-a", shopRole: "storefront" });
  await recordAttributionTouch(db, {
    trackingId: trackingIdA,
    sessionId: sessionIdA,
    attribution: { fbclid: "f1", fbc: "fb.1.1.click1", fbp: "fb.1.1.p1" },
  });

  await upsertVisitorAndSession(db, { trackingId: trackingIdB, sessionId: sessionIdB, shopId: "store-b", shopRole: "checkout" });

  await db.insert(schema.identityLinks).values({
    entityAType: "session_id",
    entityAValue: sessionIdA,
    entityBType: "session_id",
    entityBValue: sessionIdB,
    confidence: "DETERMINISTIC",
    source: "cross_domain_transfer",
  });

  await recordCheckoutStart(db, {
    sessionId: sessionIdB,
    shopId: "store-b",
    event: { commerce: { checkout_token: checkoutToken } } as unknown as TrackingEventV1,
  });

  await backfillCustomerIdentityFromOrder(db, {
    orderId,
    checkoutToken,
    payload: parseOrderWebhookPayload({ id: orderId, checkout_token: checkoutToken, customer: { email: "shopper@example.com" } }),
  });

  await db.insert(schema.orders).values({
    orderId,
    shopId: "store-b",
    checkoutToken,
    currency: "BRL",
    totalAmount: "199.90",
    state: "PAID",
    paidAt: new Date("2026-01-05T12:00:00Z"),
  });

  if (opts.grantConsent) {
    await recordConsentIfPresent(db, { shopId: "store-b", sessionId: sessionIdB, consent: { marketingAllowed: true } });
  }
}

async function getDeadLetterRow(orderId: string, shopId: string) {
  const result = await pool.query("SELECT * FROM dead_letters WHERE job_id = $1", [purchaseEventId(shopId, orderId)]);
  return result.rows[0];
}

let queue: Queue<MetaCapiJobData>;
let worker: Worker<MetaCapiJobData>;
let fetchMock: ReturnType<typeof vi.fn>;

describe("Meta CAPI worker (integration: real Postgres + real Redis, mocked fetch)", () => {
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await worker?.close();
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
  });

  it("completes successfully and never touches dead_letters when Meta accepts the event", async () => {
    await seedFullOrder("o1", "chk_o1", { grantConsent: true });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }));

    const config = baseConfig();
    queue = createMetaCapiQueue(config, { prefix: QUEUE_PREFIX })!;
    worker = createMetaCapiWorker(db, config, { prefix: QUEUE_PREFIX })!;
    await enqueuePurchaseSend(queue, { orderId: "o1", shopId: "store-b" });

    await waitFor(async () => {
      const [row] = await pool.query("SELECT meta_sent FROM event_registry WHERE event_id = $1", [
        purchaseEventId("store-b", "o1"),
      ]).then((r) => r.rows);
      return row?.meta_sent === true ? true : undefined;
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await getDeadLetterRow("o1", "store-b")).toBeUndefined();
  });

  it("records a dead letter (without ever calling fetch) for a structural gap like consent not granted, and does not retry it", async () => {
    await seedFullOrder("o2", "chk_o2", { grantConsent: false });

    const config = baseConfig();
    queue = createMetaCapiQueue(config, { prefix: QUEUE_PREFIX })!;
    worker = createMetaCapiWorker(db, config, { prefix: QUEUE_PREFIX })!;
    await enqueuePurchaseSend(queue, { orderId: "o2", shopId: "store-b" });

    const row = await waitFor(async () => getDeadLetterRow("o2", "store-b"));
    expect(row.failure_reason).toBe("consent_not_granted");
    expect(row.attempts_made).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("short-circuits immediately (single attempt) on a permanent Meta error (invalid/expired token, code 190)", async () => {
    await seedFullOrder("o3", "chk_o3", { grantConsent: true });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Error validating access token", code: 190 } }), { status: 400 }),
    );

    const config = baseConfig();
    queue = createMetaCapiQueue(config, { prefix: QUEUE_PREFIX })!;
    worker = createMetaCapiWorker(db, config, { prefix: QUEUE_PREFIX })!;
    await enqueuePurchaseSend(queue, { orderId: "o3", shopId: "store-b" });

    const row = await waitFor(async () => getDeadLetterRow("o3", "store-b"));
    expect(row.failure_reason).toBe("meta_capi_permanent_http_error_400");
    expect(row.attempts_made).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a retryable Meta error (rate limiting, code 4) up to the configured attempts, then dead-letters it", async () => {
    await seedFullOrder("o4", "chk_o4", { grantConsent: true });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Too many calls", code: 4 } }), { status: 400 }),
    );

    const config = baseConfig({ META_QUEUE_ATTEMPTS: 2 });
    queue = createMetaCapiQueue(config, { prefix: QUEUE_PREFIX })!;
    worker = createMetaCapiWorker(db, config, { prefix: QUEUE_PREFIX })!;
    await enqueuePurchaseSend(queue, { orderId: "o4", shopId: "store-b" });

    const row = await waitFor(async () => getDeadLetterRow("o4", "store-b"));
    expect(row.failure_reason).toBe("meta_capi_retryable_http_error_400");
    expect(row.attempts_made).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a network error up to the configured attempts, then dead-letters it", async () => {
    await seedFullOrder("o5", "chk_o5", { grantConsent: true });
    fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND graph.facebook.com"));

    const config = baseConfig({ META_QUEUE_ATTEMPTS: 2 });
    queue = createMetaCapiQueue(config, { prefix: QUEUE_PREFIX })!;
    worker = createMetaCapiWorker(db, config, { prefix: QUEUE_PREFIX })!;
    await enqueuePurchaseSend(queue, { orderId: "o5", shopId: "store-b" });

    const row = await waitFor(async () => getDeadLetterRow("o5", "store-b"));
    expect(row.failure_reason).toContain("meta_capi_network_error");
    expect(row.attempts_made).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("dead-letters immediately, without ever calling fetch, when Meta credentials are not configured", async () => {
    await seedFullOrder("o6", "chk_o6", { grantConsent: true });

    const config = baseConfig({ META_ACCESS_TOKEN: undefined, META_DATASET_ID: undefined, META_PIXEL_ID: undefined });
    queue = createMetaCapiQueue(config, { prefix: QUEUE_PREFIX })!;
    worker = createMetaCapiWorker(db, config, { prefix: QUEUE_PREFIX })!;
    await enqueuePurchaseSend(queue, { orderId: "o6", shopId: "store-b" });

    const row = await waitFor(async () => getDeadLetterRow("o6", "store-b"));
    expect(row.failure_reason).toBe("meta_not_configured");
    expect(row.attempts_made).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a second failure of the same order updates the existing dead_letters row instead of duplicating it", async () => {
    await seedFullOrder("o7", "chk_o7", { grantConsent: false });

    const config = baseConfig();
    queue = createMetaCapiQueue(config, { prefix: QUEUE_PREFIX })!;
    worker = createMetaCapiWorker(db, config, { prefix: QUEUE_PREFIX })!;

    await enqueuePurchaseSend(queue, { orderId: "o7", shopId: "store-b" });
    await waitFor(async () => getDeadLetterRow("o7", "store-b"));

    // Simulate a Phase-12 reconciliation replay: consent is granted after
    // the fact, but the send still fails (this time permanently). NOTE
    // (real BullMQ behavior, verified empirically against the installed
    // v6 package rather than assumed): re-adding a job under a jobId that
    // already exists in a TERMINAL state (completed/failed) is a silent
    // no-op — it does NOT re-run the processor. A genuine replay must
    // remove the old job first; this is a real constraint the Phase 12
    // Reconciliation Engine will need to follow, not just a test artifact.
    await recordConsentIfPresent(db, {
      shopId: "store-b",
      sessionId: uuid(400 + "o7".length),
      consent: { marketingAllowed: true },
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Error validating access token", code: 190 } }), { status: 400 }),
    );
    await queue.remove(purchaseEventId("store-b", "o7"));
    await enqueuePurchaseSend(queue, { orderId: "o7", shopId: "store-b" });

    const row = await waitFor(async () => {
      const current = await getDeadLetterRow("o7", "store-b");
      return current && current.failure_reason === "meta_capi_permanent_http_error_400" ? current : undefined;
    });

    const allRows = await pool.query("SELECT * FROM dead_letters WHERE job_id = $1", [purchaseEventId("store-b", "o7")]);
    expect(allRows.rowCount).toBe(1);
    expect(row.failure_reason).toBe("meta_capi_permanent_http_error_400");
  });
});
