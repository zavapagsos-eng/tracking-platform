import { createDatabase } from "@tracking/db";
import { loadConfig } from "./config.js";
import { createMetaCapiQueue } from "./lib/metaQueue.js";
import { scheduleReconciliation } from "./lib/reconciliationCron.js";

/**
 * Standalone entrypoint for the Reconciliation Engine (Phase 12) —
 * deliberately its own process, same reasoning as `src/worker.ts` (Phase
 * 11): a periodic job is its own logical component
 * (docs/ARCHITECTURE.md's "Reconciliation Engine (job periódico)"), not
 * something the HTTP gateway or the Meta CAPI worker should run as a side
 * effect. Run via `npm run reconciliation` (dev) / `reconciliation:start`
 * (built).
 *
 * Runs WITHOUT `REDIS_URL` too (unlike the worker): a reconciliation scan
 * is still valuable read-only signal (writes `reconciliation_runs` rows)
 * even when queueing isn't configured — it just can't auto-requeue
 * anything in that case (`scheduleReconciliation` logs and skips, never
 * throws).
 */
async function main() {
  const config = loadConfig();
  const { db, pool } = createDatabase(config.DATABASE_URL);
  const queue = createMetaCapiQueue(config);

  const task = scheduleReconciliation(db, queue, config);
  console.log(`Reconciliation Engine scheduled: "${config.RECONCILIATION_CRON}"`);

  const shutdown = async (signal: string) => {
    console.log(`reconciliation: received ${signal}, shutting down`);
    await task.stop();
    if (queue) await queue.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Reconciliation Engine failed to start:", err);
  process.exit(1);
});
