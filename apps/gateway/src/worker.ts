import { createDatabase } from "@tracking/db";
import { loadConfig } from "./config.js";
import { createMetaCapiWorker } from "./lib/metaWorker.js";

/**
 * Standalone entrypoint for the Meta CAPI queue consumer — deliberately a
 * SEPARATE process from the HTTP gateway (src/index.ts), matching
 * docs/ARCHITECTURE.md's "Queue + Workers" as its own logical component,
 * not something started as a side effect of the HTTP server booting. Run
 * via `npm run worker` (dev) / `npm run worker:start` (built).
 */
async function main() {
  const config = loadConfig();
  const { db, pool } = createDatabase(config.DATABASE_URL);

  const worker = createMetaCapiWorker(db, config);
  if (!worker) {
    console.error(
      "REDIS_URL is not configured — the Meta CAPI worker has nothing to consume and will exit. " +
        "Set REDIS_URL to enable queued Meta CAPI delivery (see .env.example).",
    );
    await pool.end();
    process.exit(1);
  }

  console.log(`Meta CAPI worker started, consuming queue "${worker.name}"`);

  const shutdown = async (signal: string) => {
    console.log(`worker: received ${signal}, shutting down`);
    await worker.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Meta CAPI worker failed to start:", err);
  process.exit(1);
});
