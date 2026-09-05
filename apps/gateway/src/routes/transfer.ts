import type { FastifyInstance } from "fastify";
import { createTransfer, recordTransferRedirect, redeemTransfer } from "../lib/transfer.js";
import { requireValidSignature } from "../lib/hmacGuard.js";
import { createTransferBodySchema, redeemTransferBodySchema } from "../lib/transferSchemas.js";
import { findStoreByShopId } from "../config.js";

/**
 * These `/v1/transfer/*` endpoints are the SERVER-TO-SERVER path, guarded
 * by a shared-secret HMAC header. They exist for trusted backend callers
 * (internal tooling, background jobs) — NOT for the browser. Browser-side
 * callers (the Store A/B pixel or theme code) must use the App-Proxy
 * authenticated `/proxy/transfer/*` routes instead (see routes/proxy.ts),
 * because a shared secret embedded in client-side JS would be visible to
 * anyone viewing source (spec section 59). See docs/PHASE_LOG.md Phase 4.
 */
export async function registerTransferRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/transfer/create", async (request, reply) => {
    const authorized = await requireValidSignature(request, reply, app.config.GATEWAY_HMAC_SECRET);
    if (!authorized) return;

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

  app.post("/v1/transfer/redeem", async (request, reply) => {
    const authorized = await requireValidSignature(request, reply, app.config.GATEWAY_HMAC_SECRET);
    if (!authorized) return;

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

  // Server-assisted redirect (spec section 10): registers the exact
  // server-observed moment of the Hub -> destination-store handoff, then
  // 302s to THAT transfer's own destination store's cart permalink
  // (resolved per-transfer from `SHOPIFY_STORES`, never a single
  // Gateway-wide domain — a Hub can route different products to different
  // destination stores, see docs/PHASE_LOG.md's "Correção de Arquitetura —
  // Multi-Loja de Destino") carrying the (still unredeemed) token as a
  // cart attribute. Redemption itself happens later, from that store's own
  // Web Pixel installation.
  app.get<{ Params: { token: string } }>("/r/:token", async (request, reply) => {
    const { token } = request.params;

    const outcome = await recordTransferRedirect(app.db, token);
    if (outcome.status === "not_found") {
      return reply.code(404).send({ error: "transfer_not_found" });
    }
    if (outcome.status === "expired") {
      return reply.code(410).send({ error: "transfer_expired" });
    }

    const destinationStore = findStoreByShopId(app.config, outcome.destinationShopId);
    if (!destinationStore) {
      // The transfer names a shop_id that isn't (or is no longer) in
      // SHOPIFY_STORES — fail closed rather than guess a domain, e.g. by
      // falling back to some other configured store.
      request.log.error(
        { destinationShopId: outcome.destinationShopId },
        "transfer's destination_shop_id is not a registered store in SHOPIFY_STORES",
      );
      return reply.code(500).send({ error: "redirect_target_not_configured" });
    }

    // Shopify cart permalink format: /cart/{variant}:{qty},{variant}:{qty}.
    // Falls back to a bare /cart when no snapshot was captured at
    // transfer-create time (still carries the token so the destination
    // store can at least link the sessions, even without pre-filling the cart).
    const cartPath =
      outcome.cartSnapshot && outcome.cartSnapshot.length > 0
        ? `/cart/${outcome.cartSnapshot.map((line) => `${line.variant_id}:${line.quantity}`).join(",")}`
        : "/cart";

    const url = new URL(`https://${destinationStore.domain}${cartPath}`);
    url.searchParams.set("attributes[ttid]", token);

    return reply.code(302).header("Location", url.toString()).send();
  });
}
