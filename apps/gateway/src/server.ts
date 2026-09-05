import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Queue } from "bullmq";
import type { Database } from "@tracking/db";
import type { GatewayConfig } from "./config.js";
import rawBodyPlugin from "./plugins/rawBody.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerTransferRoutes } from "./routes/transfer.js";
import { registerProxyRoutes } from "./routes/proxy.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { createMetaCapiQueue, type MetaCapiJobData } from "./lib/metaQueue.js";

export interface GatewayDeps {
  db: Database;
  config: GatewayConfig;
}

export async function buildServer(deps: GatewayDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.config.LOG_LEVEL,
      // Structured JSON logging with a correlation id per request (spec
      // section 44) — Fastify's built-in reqId is used as correlation_id.
      redact: ["req.headers.authorization", "req.headers['x-gateway-signature']"],
    },
    trustProxy: true,
  });

  app.decorate("db", deps.db);
  app.decorate("config", deps.config);
  // `undefined` when REDIS_URL isn't configured — routes that enqueue a
  // Meta CAPI send treat that as "queueing not available yet" and log
  // rather than fail the webhook ack (fail-open, per docs/ARCHITECTURE.md
  // section J: the Gateway must never block a Shopify webhook 200 on an
  // optional downstream integration).
  const metaQueue = createMetaCapiQueue(deps.config);
  app.decorate("metaQueue", metaQueue);
  if (metaQueue) {
    app.addHook("onClose", async () => {
      await metaQueue.close();
    });
  }

  await app.register(helmet, { global: true });

  await app.register(cors, {
    origin: deps.config.CORS_ALLOWLIST.length > 0 ? deps.config.CORS_ALLOWLIST : false,
    methods: ["GET", "POST"],
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  await app.register(rawBodyPlugin);

  await registerHealthRoutes(app);
  await registerEventRoutes(app);
  await registerTransferRoutes(app);
  await registerProxyRoutes(app);
  await registerWebhookRoutes(app);
  await registerAdminRoutes(app);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    config: GatewayConfig;
    metaQueue: Queue<MetaCapiJobData> | undefined;
  }
}
