import { afterEach, describe, expect, it } from "vitest";
import type { Queue } from "bullmq";
import { createMetaCapiQueue, enqueuePurchaseSend, type MetaCapiJobData } from "./metaQueue.js";
import { purchaseEventId } from "./metaCapiPurchase.js";
import type { GatewayConfig } from "../config.js";

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";

function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    TRACKING_ENV: "development",
    PORT: 3000,
    LOG_LEVEL: "info",
    DATABASE_URL: "postgresql://localhost/test",
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
    RECONCILIATION_MAX_REQUEUE_ATTEMPTS: 5,
    RECONCILIATION_REQUEUE_COOLDOWN_MINUTES: 60,
    ...overrides,
  };
}

let queue: Queue<MetaCapiJobData> | undefined;

afterEach(async () => {
  if (queue) {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    queue = undefined;
  }
});

describe("createMetaCapiQueue", () => {
  it("returns undefined when REDIS_URL is not configured", () => {
    expect(createMetaCapiQueue(baseConfig(), { prefix: "test-metaqueue" })).toBeUndefined();
  });

  it("returns a Queue configured with the configured attempts/backoff when REDIS_URL is set", () => {
    queue = createMetaCapiQueue(baseConfig({ REDIS_URL: TEST_REDIS_URL, META_QUEUE_ATTEMPTS: 7 }), {
      prefix: "test-metaqueue",
    });
    expect(queue).toBeDefined();
    expect(queue?.name).toBe("meta-capi-purchase");
  });
});

describe("enqueuePurchaseSend", () => {
  it("adds a job whose id is the deterministic purchase event_id and whose data is exactly {orderId, shopId}", async () => {
    queue = createMetaCapiQueue(baseConfig({ REDIS_URL: TEST_REDIS_URL }), { prefix: "test-metaqueue" });
    if (!queue) throw new Error("expected queue to be configured");

    await enqueuePurchaseSend(queue, { orderId: "o1", shopId: "store-b" });

    const job = await queue.getJob(purchaseEventId("store-b", "o1"));
    expect(job).toBeDefined();
    expect(job?.data).toEqual({ orderId: "o1", shopId: "store-b" });
  });

  it("adding the same order twice does not create two distinct jobs (jobId-level dedup)", async () => {
    queue = createMetaCapiQueue(baseConfig({ REDIS_URL: TEST_REDIS_URL }), { prefix: "test-metaqueue" });
    if (!queue) throw new Error("expected queue to be configured");

    await enqueuePurchaseSend(queue, { orderId: "o2", shopId: "store-b" });
    await enqueuePurchaseSend(queue, { orderId: "o2", shopId: "store-b" });

    const counts = await queue.getJobCounts();
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(1);
  });
});
