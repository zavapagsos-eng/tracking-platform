import { defineConfig } from "drizzle-kit";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://tracking:tracking_dev_pw@localhost:5432/tracking_dev";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
