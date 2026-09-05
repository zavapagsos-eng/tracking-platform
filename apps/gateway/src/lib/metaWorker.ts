import { Worker, UnrecoverableError, type Job } from "bullmq";
import type { Database } from "@tracking/db";
import type { GatewayConfig } from "../config.js";
import { resolveMetaCredentials } from "./metaCapiClient.js";
import { sendPurchaseToMeta, purchaseEventId } from "./metaCapiPurchase.js";
import { classifyMetaHttpError } from "./metaErrorClassification.js";
import { recordDeadLetter } from "./deadLetter.js";
import { META_CAPI_QUEUE_NAME, type MetaCapiJobData } from "./metaQueue.js";

/**
 * Runs one queued job: resolves Meta credentials fresh from config (never
 * baked into job data), calls `sendPurchaseToMeta`, and turns every
 * possible `SendPurchaseResult` status into one of exactly two outcomes —
 * per docs/ARCHITECTURE.md section J's split between errors worth BullMQ's
 * retry/backoff and ones that are not:
 *
 * 1. STRUCTURAL / DATA GAPS (`consent_not_granted` and every journey-
 *    resolution miss `reconstructJourneyByOrderId` can produce) — these
 *    are not bugs, and retrying the identical input a few seconds later
 *    (BullMQ's backoff) will not change Shopify's Order data or a
 *    customer's stored consent. The job COMPLETES (returns normally, no
 *    throw — this worker did everything it legitimately could) and is
 *    recorded directly to `dead_letters` here, so the Reconciliation
 *    Engine (Phase 12) can find and re-attempt it once the underlying gap
 *    may have closed (e.g. a late-arriving Pixel event, consent granted
 *    afterward).
 * 2. ACTUAL META CAPI ERRORS (`network_error`, `http_error`) — these DO
 *    throw, so BullMQ's configured `attempts`/`backoff` apply. A
 *    `classifyMetaHttpError` "permanent" result (or missing Meta
 *    credentials entirely) throws `UnrecoverableError` to skip the
 *    remaining attempts immediately rather than waste them on a request
 *    that will fail the same way every time. Either way, recording to
 *    `dead_letters` for this branch happens in exactly one place — the
 *    `worker.on("failed", ...)` listener below — keyed off `job.finishedOn`
 *    being set (BullMQ's own signal, per its installed source, that THIS
 *    was the terminal failure and not just one more attempt still queued
 *    to retry) so a job is never recorded twice across several retries.
 */
export function buildMetaCapiProcessor(db: Database, config: GatewayConfig) {
  return async function processMetaCapiJob(job: Job<MetaCapiJobData>): Promise<void> {
    const credentials = resolveMetaCredentials(config);
    if (!credentials) {
      // Not a job-specific problem — retrying won't make credentials
      // appear. Never silently drop it: it still needs a human to notice.
      throw new UnrecoverableError("meta_not_configured");
    }

    const result = await sendPurchaseToMeta(db, job.data.orderId, credentials);

    switch (result.status) {
      case "sent":
      case "already_sent":
        return;
      case "network_error":
        // Transient by definition (DNS/connection failure) — let BullMQ retry.
        throw new Error(`meta_capi_network_error: ${result.error}`);
      case "http_error": {
        const classification = classifyMetaHttpError(result.responseRedacted);
        if (classification === "permanent") {
          throw new UnrecoverableError(`meta_capi_permanent_http_error_${result.httpStatus}`);
        }
        throw new Error(`meta_capi_retryable_http_error_${result.httpStatus}`);
      }
      default:
        // Every remaining status (`consent_not_granted`, `order_not_found`,
        // `no_checkout_correlation`, `checkout_not_tracked`,
        // `session_not_tracked`) is a named, expected structural gap — see
        // the module comment above for why these complete rather than throw.
        await recordDeadLetter(db, {
          queueName: META_CAPI_QUEUE_NAME,
          jobId: job.id ?? purchaseEventId(job.data.shopId, job.data.orderId),
          jobData: job.data,
          failureReason: result.status,
          // `job.attemptsMade` only increments AFTER the processor returns
          // (verified in the installed package's source, Phase 11
          // research: `Job.moveToCompleted`/`moveToFailed`) — from inside
          // the still-running processor it reflects attempts before this
          // one, so `+ 1` is what makes this recorded count mean "this
          // call was attempt number N", consistent with the `failed`
          // listener below (which runs after that increment already
          // happened, so needs no such adjustment).
          attemptsMade: job.attemptsMade + 1,
        });
        return;
    }
  };
}

/**
 * Constructs the Meta CAPI Purchase worker — or `undefined` when
 * `REDIS_URL` isn't configured (same fail-closed shape as
 * `createMetaCapiQueue`). Meant to run in its own process
 * (see src/worker.ts), separate from the HTTP gateway, matching
 * docs/ARCHITECTURE.md's "Queue + Workers" as its own logical component —
 * not started as a side effect of `buildServer()`.
 */
export function createMetaCapiWorker(
  db: Database,
  config: GatewayConfig,
  opts: { prefix?: string } = {},
): Worker<MetaCapiJobData> | undefined {
  if (!config.REDIS_URL) return undefined;

  const worker = new Worker<MetaCapiJobData>(META_CAPI_QUEUE_NAME, buildMetaCapiProcessor(db, config), {
    connection: { url: config.REDIS_URL, maxRetriesPerRequest: null },
    prefix: opts.prefix,
  });

  worker.on("failed", (job, err) => {
    if (!job) return;
    // `finishedOn` is set by BullMQ's own `Job.moveToFailed` ONLY on the
    // branch where it decided NOT to retry (verified in the installed
    // package's source, Phase 11 research) — i.e. exactly the terminal
    // failure, whether that's because `attempts` is exhausted or an
    // `UnrecoverableError` short-circuited retries. An intermediate
    // attempt that BullMQ has already rescheduled leaves it unset, so this
    // never records a job that is, in fact, still going to retry.
    if (!job.finishedOn) return;
    void recordDeadLetter(db, {
      queueName: META_CAPI_QUEUE_NAME,
      jobId: job.id ?? purchaseEventId(job.data.shopId, job.data.orderId),
      jobData: job.data,
      failureReason: err instanceof Error ? err.message : String(err),
      attemptsMade: job.attemptsMade,
    }).catch((dbErr) => {
      // Never let a dead-letter bookkeeping failure crash the worker
      // process itself (fail-open, same philosophy as the rest of this
      // codebase's best-effort side writes).
      console.error("failed to record dead letter", dbErr);
    });
  });

  return worker;
}
