import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "./client.js";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  const { db, pool } = createDatabase(databaseUrl);
  try {
    await migrate(db, { migrationsFolder: new URL("../migrations", import.meta.url).pathname });
    console.log("Migrations applied successfully.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exitCode = 1;
});
