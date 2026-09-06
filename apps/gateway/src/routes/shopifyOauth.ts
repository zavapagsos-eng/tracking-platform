import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { findStoreByMyshopifyDomain, type GatewayConfig } from "../config.js";

/**
 * Activates the Web Pixel extension shipped by one of this project's two
 * small Shopify apps ("Store A" / Hub, "Store B" / checkout stores — see
 * config.ts's PIXEL_APP_STORE_A/B_* comment for why there are two).
 *
 * A Web Pixel App Extension does NOT self-activate on install — confirmed
 * against shopify.dev/docs/apps/build/marketing-analytics/build-web-pixels
 * after it silently failed to appear in Settings > Customer events despite
 * a clean `shopify app deploy` and a successful install: the merchant's
 * OAuth grant only authorizes the app; something authenticated as that
 * install still has to call the `webPixelCreate` Admin GraphQL mutation
 * once, with the pixel's initial `settings` JSON, before Shopify creates
 * the pixel record and flips it from absent to "Connected." This route is
 * that "something" — the standard OAuth authorization-code callback,
 * reached because each app's `shopify.app.toml` `[auth] redirect_urls`
 * points here instead of the CLI-scaffolded placeholder.
 */

interface PixelAppDef {
  clientId: string;
  clientSecret: string;
  /** Matches StoreEntry.role — decides which extra Web Pixel settings
   * field this app's install needs (see buildSettings below). */
  kind: "storefront" | "checkout";
}

function getPixelApps(config: GatewayConfig): PixelAppDef[] {
  const apps: PixelAppDef[] = [];
  if (config.PIXEL_APP_STORE_A_CLIENT_ID && config.PIXEL_APP_STORE_A_CLIENT_SECRET) {
    apps.push({
      clientId: config.PIXEL_APP_STORE_A_CLIENT_ID,
      clientSecret: config.PIXEL_APP_STORE_A_CLIENT_SECRET,
      kind: "storefront",
    });
  }
  if (config.PIXEL_APP_STORE_B_CLIENT_ID && config.PIXEL_APP_STORE_B_CLIENT_SECRET) {
    apps.push({
      clientId: config.PIXEL_APP_STORE_B_CLIENT_ID,
      clientSecret: config.PIXEL_APP_STORE_B_CLIENT_SECRET,
      kind: "checkout",
    });
  }
  return apps;
}

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

function buildPixelSettings(
  config: GatewayConfig,
  app: PixelAppDef,
  shopId: string | undefined,
): Record<string, string> {
  const settings: Record<string, string> = {
    gateway_url: config.GATEWAY_PUBLIC_URL ?? "",
    shop_id: shopId ?? "",
    environment: config.TRACKING_ENV,
  };
  if (app.kind === "checkout") {
    // Matches extensions/web-pixel-store-b/shopify.extension.toml's
    // `app_proxy_base_path` field — the fixed App Proxy path this app is
    // configured with on every install, never per-shop.
    settings.app_proxy_base_path = "/apps/tracking";
  }
  return settings;
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

    const store = findStoreByMyshopifyDomain(app.config, shop);
    if (!store) {
      // Fail closed rather than activating a pixel with a blank shop_id
      // (spec section 6/59: never guess a store's identity) — this store
      // still needs a SHOPIFY_STORES entry (with myshopify_domain set)
      // before its pixel can report events with a valid shop_id.
      app.log.error({ shop }, "shopify oauth callback: no SHOPIFY_STORES entry for this shop");
      return reply
        .code(500)
        .type("text/html")
        .send(
          `<html><body><h1>Instalação incompleta</h1><p>A loja ${shop} ainda não está cadastrada no Gateway (SHOPIFY_STORES). Avise o time técnico.</p></body></html>`,
        );
    }

    const settings = buildPixelSettings(app.config, pixelApp, store.shop_id);
    const mutation = `mutation TrackingPlatformWebPixelCreate($webPixel: WebPixelInput!) {
      webPixelCreate(webPixel: $webPixel) {
        userErrors { field message }
        webPixel { id }
      }
    }`;

    try {
      const gqlResponse = await fetch(`https://${shop}/admin/api/2026-10/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: mutation,
          variables: { webPixel: { settings: JSON.stringify(settings) } },
        }),
      });
      const gqlJson = (await gqlResponse.json()) as {
        data?: { webPixelCreate?: { userErrors?: { field: string[]; message: string }[]; webPixel?: { id: string } } };
        errors?: unknown;
      };
      const userErrors = gqlJson.data?.webPixelCreate?.userErrors ?? [];
      if (!gqlResponse.ok || gqlJson.errors || userErrors.length > 0) {
        app.log.warn(
          { shop, shopId: store.shop_id, status: gqlResponse.status, errors: gqlJson.errors, userErrors },
          "shopify oauth callback: webPixelCreate did not succeed cleanly",
        );
      } else {
        app.log.info(
          { shop, shopId: store.shop_id, webPixelId: gqlJson.data?.webPixelCreate?.webPixel?.id },
          "shopify oauth callback: web pixel activated",
        );
      }
    } catch (error) {
      app.log.error({ shop, error }, "shopify oauth callback: webPixelCreate threw");
    }

    return reply.type("text/html").send(
      `<html><body style="font-family: sans-serif; padding: 2rem;"><h1>Tracking Platform Pixel instalado</h1><p>Pode fechar esta aba e voltar para a loja em Configurações &gt; Eventos de clientes.</p></body></html>`,
    );
  });
}
