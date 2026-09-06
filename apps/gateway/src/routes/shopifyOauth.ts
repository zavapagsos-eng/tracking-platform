import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getPixelApps, activateWebPixel } from "../lib/webPixelActivation.js";

/**
 * The classic OAuth authorization-code callback — kept as a fallback, but
 * confirmed NOT to be the route Shopify actually uses for this project's
 * two `embedded = true` Web Pixel apps (see routes/shopifyEmbedded.ts's
 * header comment for what real installs hit instead: the embedded
 * token-exchange bootstrap at the Gateway's bare root). Left in place in
 * case a future non-embedded distribution of one of these apps, or a
 * scope-change reauthorization, ever does redirect through
 * `[auth] redirect_urls`.
 */

/** Verifies Shopify's OAuth callback signature: HMAC-SHA256 (hex) of every
 * query param except `hmac`/`signature`, sorted by key and joined
 * `key=value` with `&` — the exact algorithm documented at
 * shopify.dev/docs/apps/build/authentication-authorization/get-access-tokens/authorization-code-grant,
 * verified against this project's existing per-store webhook HMAC check
 * (lib/shopifyWebhookAuth.ts) for the constant-time-compare convention. */
function verifyOauthHmac(query: Record<string, string>, clientSecret: string): boolean {
  const { hmac, signature: _signature, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join("&");
  const expected = createHmac("sha256", clientSecret).update(message).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(hmac, "hex");
  } catch {
    return false;
  }
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

export async function registerShopifyOauthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/shopify/oauth/callback", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const { code, shop, client_id: clientId } = query;

    if (!code || !shop || !clientId) {
      return reply.code(400).send({ error: "missing_params" });
    }
    if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) {
      return reply.code(400).send({ error: "invalid_shop" });
    }

    const pixelApp = getPixelApps(app.config).find((candidate) => candidate.clientId === clientId);
    if (!pixelApp) {
      app.log.warn({ clientId }, "shopify oauth callback: unknown client_id");
      return reply.code(404).send({ error: "unknown_app" });
    }
    if (!verifyOauthHmac(query, pixelApp.clientSecret)) {
      app.log.warn({ shop }, "shopify oauth callback: invalid hmac");
      return reply.code(401).send({ error: "invalid_hmac" });
    }

    let accessToken: string;
    try {
      const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: pixelApp.clientId,
          client_secret: pixelApp.clientSecret,
          code,
        }),
      });
      if (!tokenResponse.ok) {
        app.log.error(
          { shop, status: tokenResponse.status },
          "shopify oauth callback: token exchange failed",
        );
        return reply.code(502).send({ error: "token_exchange_failed" });
      }
      const tokenJson = (await tokenResponse.json()) as { access_token?: string };
      if (!tokenJson.access_token) {
        return reply.code(502).send({ error: "token_exchange_missing_token" });
      }
      accessToken = tokenJson.access_token;
    } catch (error) {
      app.log.error({ shop, error }, "shopify oauth callback: token exchange threw");
      return reply.code(502).send({ error: "token_exchange_error" });
    }

    await activateWebPixel(app.log, app.config, pixelApp, shop, accessToken);

    return reply.type("text/html").send(
      `<html><body style="font-family: sans-serif; padding: 2rem;"><h1>Tracking Platform Pixel instalado</h1><p>Pode fechar esta aba e voltar para a loja em Configurações &gt; Eventos de clientes.</p></body></html>`,
    );
  });
}
