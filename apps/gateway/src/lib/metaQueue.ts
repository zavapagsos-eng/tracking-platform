import { Queue } from "bullmq";
import type { GatewayConfig } from "../config.js";
import { purchaseEventId } from "./metaCapiPurchase.js";

/** Deliberately just enough to re-run `sendPurchaseToMeta` — never the
 * Meta credentials themselves (those are resolved fresh from config at
 * process time, see lib/metaWorker.ts) or any other secret. Job data is
 * persisted in Redis for the life of the job (and, on failure, mirrored
 * into `dead_letters` — see lib/deadLetter.ts), so keeping it this small
 * and secret-free is a deliberate security choice, not an oversight. */
export interface MetaCapiJobData {
  orderId: string;
  shopId: string;
}

export const META_CAPI_QUEUE_NAME = "meta-capi-purchase";

/**
 * Builds the BullMQ connection options for a Redis URL. Verified against
 * the installed `bullmq` v6 package's own `RedisOptions` type (Phase 11
 * research: `node_modules/bullmq/dist/esm/interfaces/redis-options.d.ts`)
 * and its `redis-connection.js`, which special-cases a `url` field by
 * constructing `new IORedis(url, rest)` internally — so a plain
 * `{ url, ...}` object is the documented-by-source-code way to hand BullMQ
 * a full connection string, without this project taking on `ioredis` API
 * surface of its own beyond the one peer dependency BullMQ requires.
 *
 * `maxRetriesPerRequest: null` is required specifically for Worker
 * connections (BullMQ's own connections guide) because a Worker holds a
 * blocking connection that must keep retrying indefinitely rather than
 * give up while Redis is briefly unavailable; harmless to also set for the
 * Queue (producer) side.
 */
function buildRedisConnectionOptions(redisUrl: string) {
  return { url: redisUrl, maxRetriesPerRequest: null as null };
}

/**
 * Constructs the Meta CAPI Purchase queue — or `undefined` when
 * `REDIS_URL` isn't configured. Mirrors `resolveMetaCredentials()`'s
 * fail-closed shape: no queue/worker is ever partially constructed against
 * a Redis that was never actually configured, matching the same
 * "boot without this integration, gate at call time" pattern already used
 * for Meta and for the per-store webhook secrets.
 *
 * `opts.prefix` namespaces this queue's Redis keys (BullMQ's own
 * `KeyPrefixOptions`, default `"bull"`) — used by this project's own tests
 * to keep each test file's jobs isolated from every other's on the one
 * shared Redis instance, and equally useful in production for running more
 * than one environment against a single Redis.
 */
export function createMetaCapiQueue(
  config: GatewayConfig,
  opts: { prefix?: string } = {},
): Queue<MetaCapiJobData> | undefined {
  if (!config.REDIS_URL) return undefined;
  return new Queue<MetaCapiJobData>(META_CAPI_QUEUE_NAME, {
    connection: buildRedisConnectionOptions(config.REDIS_URL),
    prefix: opts.prefix,
    defaultJobOptions: {
      attempts: config.META_QUEUE_ATTEMPTS,
      backoff: {
        type: "exponential",
        delay: config.META_QUEUE_BACKOFF_DELAY_MS,
        jitter: config.META_QUEUE_BACKOFF_JITTER,
      },
      // Keep a bounded history for operational visibility without letting
      // Redis grow unbounded — the durable record of what happened lives
      // in Postgres (`meta_deliveries`, `dead_letters`), not in BullMQ's
      // own completed/failed sets.
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    },
  });
}

/**
 * Enqueues (or, harmlessly, re-targets an existing not-yet-finished job
 * for) sending one order's Purchase event to Meta CAPI. `jobId` is the
 * SAME deterministic id as the Purchase event itself
 * (`purchase:{shop_id}:{order_id}`) — a defensive extra layer of dedup at
 * the queue level, on top of (never instead of) `sendPurchaseToMeta`'s own
 * `event_registry.meta_sent` gate, which remains the actual source of
 * truth for "has this been sent."
 */
export async function enqueuePurchaseSend(
  queue: Queue<MetaCapiJobData>,
  params: { orderId: string; shopId: string },
): Promise<void> {
  await queue.add(
    "send-purchase",
    { orderId: params.orderId, shopId: params.shopId },
    { jobId: purchaseEventId(params.shopId, params.orderId) },
  );
}
