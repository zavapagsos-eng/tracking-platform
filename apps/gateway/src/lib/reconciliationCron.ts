import cron, { type ScheduledTask } from "node-cron";
import type { Database } from "@tracking/db";
import type { Queue } from "bullmq";
import type { GatewayConfig } from "../config.js";
import type { MetaCapiJobData } from "./metaQueue.js";
import { requeueEligibleOrders, runReconciliation, type ReconciliationResult } from "./reconciliation.js";

/**
 * Runs exactly one reconciliation cycle: scan (`runReconciliation`) then
 * bounded auto-requeue (`requeueEligibleOrders`) — factored out of the
 * cron wiring below so it can be invoked directly (by the Phase 13 Admin
 * Dashboard's "run now" action, or by tests) without going through
 * `node-cron` at all.
 */
export async function runReconciliationCycle(
  db: Database,
  queue: Queue<MetaCapiJobData> | undefined,
  config: GatewayConfig,
): Promise<{ result: ReconciliationResult; requeuedCount: number }> {
  const result = await runReconciliation(db, config);

  if (!queue) {
    return { result, requeuedCount: 0 };
  }

  const outcomes = await requeueEligibleOrders(db, queue, config, result.details);
  return { result, requeuedCount: outcomes.filter((o) => o.requeued).length };
}

/**
 * Wires `runReconciliationCycle` to `RECONCILIATION_CRON` (config.ts) via
 * `node-cron` — verified against the installed package's own type
 * definitions (`node_modules/node-cron/dist/node-cron.d.ts`): `schedule()`
 * returns a `ScheduledTask` whose `.stop()` is what a graceful shutdown
 * needs, not a bare interval handle. Meant to run in the same standalone
 * process as `src/reconciliationCron.ts` — never as a side effect of
 * `buildServer()`, matching this project's existing pattern for the Meta
 * CAPI worker (`lib/metaWorker.ts`/`src/worker.ts`, Phase 11).
 */
export function scheduleReconciliation(
  db: Database,
  queue: Queue<MetaCapiJobData> | undefined,
  config: GatewayConfig,
  onCycle?: (outcome: { result: ReconciliationResult; requeuedCount: number }) => void,
): ScheduledTask {
  return cron.schedule(config.RECONCILIATION_CRON, () => {
    void runReconciliationCycle(db, queue, config)
      .then((outcome) => {
        const { summary } = outcome.result;
        console.log(
          `[reconciliation] run ${summary.runId}: matched=${summary.matched} missing_meta=${summary.missingMeta} ` +
            `missing_local=${summary.missingLocal} duplicated=${summary.duplicated} value_mismatch=${summary.valueMismatch} ` +
            `currency_mismatch=${summary.currencyMismatch} unattributed=${summary.unattributed} requeued=${outcome.requeuedCount}`,
        );
        onCycle?.(outcome);
      })
      .catch((err) => {
        console.error("[reconciliation] cycle failed:", err);
      });
  });
}
