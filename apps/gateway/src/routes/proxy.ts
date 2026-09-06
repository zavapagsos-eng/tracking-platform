import type { FastifyInstance } from "fastify";
import { verifyAppProxySignatureAny } from "../lib/appProxy.js";
import { createTransfer, redeemTransfer } from "../lib/transfer.js";
import { createTransferBodySchema, redeemTransferBodySchema } from "../lib/transferSchemas.js";
import { getPixelApps } from "../lib/webPixelActivation.js";
import type { GatewayConfig } from "../config.js";

/**
 * Every client secret that could legitimately have signed an incoming App
 * Proxy request: the legacy single `SHOPIFY_APP_PROXY_SECRET` (kept for
 * backward compatibility / single-app deployments) plus each of the
 * per-store pixel apps' own client secrets (Store A/B/C — see
 * lib/appProxy.ts's `verifyAppProxySignatureAny` doc comment for why a
 * single shared secret cannot work once more than one Shopify app is
 * involved). De-duplicated since A/B/C could in theory share a secret.
 */
function getAppProxySecretCandidates(config: GatewayConfig): string[] {
  const secrets = new Set<string>();
  if (config.SHOPIFY_APP_PROXY_SECRET) secrets.add(config.SHOPIFY_APP_PROXY_SECRET);
  for (const pixelApp of getPixelApps(config)) {
    secrets.add(pixelApp.clientSecret);
  }
  return [...secrets];
}

/**
 * Browser-facing counterparts of /v1/transfer/create and /v1/transfer/redeem,
 * reachable through Shopify's App Proxy (e.g. the storefront calls the
 * same-origin `https://store-a.example.com/apps/tracking/transfer/create`,
 * which Shopify's edge forwards here as
 * `POST /proxy/transfer/create?shop=...&timestamp=...&signature=...`,
 * appending a signature computed with the app's own client secret — never
 * present in the browser). See lib/appProxy.ts for the verification
 * algorithm and docs/PHASE_LOG.md Phase 4 for why this exists instead of
 * reusing the /v1/transfer/* HMAC-header scheme for client-side callers.
 *
 * The exact proxy sub-path (`/apps/tracking`) is configured per-app in the
 * Shopify Partner Dashboard when the app is installed on a real store —
 * out of scope until real store/app credentials exist (Phase 16).
 */
export async function registerProxyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/proxy/")) return;

    const candidateSecrets = getAppProxySecretCandidates(app.config);
    if (candidateSecrets.length === 0) {
      request.log.error("no app proxy secret configured (SHOPIFY_APP_PROXY_SECRET / PIXEL_APP_*_CLIENT_SECRET)");
      return reply.code(501).send({ error: "app_proxy_not_configured" });
    }

    const url = new URL(request.url, "http://internal");
    if (!verifyAppProxySignatureAny(url.searchParams, candidateSecrets)) {
      return reply.code(401).send({ error: "invalid_app_proxy_signature" });
    }
  });

  app.post("/proxy/transfer/create", async (request, reply) => {
    const parsed = createTransferBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request_body", details: parsed.error.issues });
    }

    const result = await createTransfer(app.db, {
      trackingId: parsed.data.tracking_id,
      sessionId: parsed.data.session_id,
      destinationShopId: parsed.data.destination_shop_id,
      ttlSeconds: app.config.TRANSFER_TOKEN_TTL_SECONDS,
      cartSnapshot: parsed.data.cart ?? null,
    });

    return reply.code(201).send({
      token: result.token,
      expires_at: result.expiresAt.toISOString(),
      redirect_path: `/r/${result.token}`,
    });
  });

  app.post("/proxy/transfer/redeem", async (request, reply) => {
    const parsed = redeemTransferBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request_body", details: parsed.error.issues });
    }

    const result = await redeemTransfer(app.db, {
      token: parsed.data.token,
      redeemedSessionId: parsed.data.session_id,
    });

    switch (result.status) {
      case "redeemed":
        return reply.code(200).send({
          status: "redeemed",
          tracking_id: result.trackingId,
          source_session_id: result.sourceSessionId,
        });
      case "not_found":
        return reply.code(404).send({ status: "not_found" });
      case "expired":
        return reply.code(410).send({ status: "expired" });
      case "replay_detected":
        return reply.code(409).send({ status: "replay_detected" });
    }
  });
}
