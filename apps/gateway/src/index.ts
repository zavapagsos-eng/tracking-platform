import { createDatabase } from "@tracking/db";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

async function main() {
  const config = loadConfig();
  const { db, pool } = createDatabase(config.DATABASE_URL);
  const app = await buildServer({ db, config });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("Gateway failed to start:", err);
  process.exit(1);
});
