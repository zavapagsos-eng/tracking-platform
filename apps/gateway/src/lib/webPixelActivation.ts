import { findStoreByMyshopifyDomain, type GatewayConfig } from "../config.js";
import type { FastifyBaseLogger } from "fastify";

/**
 * Shared between the two ways a Web Pixel install can reach the Gateway:
 * the classic OAuth authorization-code callback (routes/shopifyOauth.ts —
 * kept as a fallback) and the embedded-app token-exchange bootstrap
 * (routes/shopifyEmbedded.ts — confirmed by testing against the real Hub
 * install to be the one Shopify actually uses for an `embedded = true`
 * custom app: it never redirects to `[auth] redirect_urls` at all, it
 * loads `application_url` directly with a session `id_token` for the
 * app's own backend to exchange). Both end the same way: an access token
 * in hand, then `webPixelCreate`.
 */

export interface PixelAppDef {
  clientId: string;
  clientSecret: string;
  /** Matches StoreEntry.role — decides which extra Web Pixel settings
   * field this app's install needs (see buildPixelSettings below). */
  kind: "storefront" | "checkout";
}

export function getPixelApps(config: GatewayConfig): PixelAppDef[] {
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
  if (config.PIXEL_APP_STORE_C_CLIENT_ID && config.PIXEL_APP_STORE_C_CLIENT_SECRET) {
    apps.push({
      clientId: config.PIXEL_APP_STORE_C_CLIENT_ID,
      clientSecret: config.PIXEL_APP_STORE_C_CLIENT_SECRET,
      kind: "checkout",
    });
  }
  return apps;
}

export function buildPixelSettings(
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

/** Calls `webPixelCreate` for a freshly-authorized install and logs the
 * outcome. Never throws — a failed activation shouldn't break the
 * install/embed response the merchant is waiting on; it's logged so it
 * can be retried by re-opening the app (both call sites here get a fresh
 * token each time). Returns true only on a clean, error-free create. */
export async function activateWebPixel(
  log: FastifyBaseLogger,
  config: GatewayConfig,
  app: PixelAppDef,
  shop: string,
  accessToken: string,
): Promise<boolean> {
  const store = findStoreByMyshopifyDomain(config, shop);
  if (!store) {
    // Logs only shop_id/domain/role — never webhook_secret — so this is
    // safe to inspect via `railway logs` when diagnosing a mismatch
    // between a real install's `shop` and this registry's `domain`/
    // `myshopify_domain` without needing to expose any secret.
    const knownStores = config.SHOPIFY_STORES.map((s) => ({
      shop_id: s.shop_id,
      domain: s.domain,
      myshopify_domain: s.myshopify_domain,
      role: s.role,
    }));
    log.error({ shop, knownStores }, "web pixel activation: no SHOPIFY_STORES entry for this shop");
    return false;
  }

  const settings = buildPixelSettings(config, app, store.shop_id);
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
      // Expected on a second app-open for an already-activated shop
      // (Shopify returns a userError rather than silently no-op'ing) —
      // logged at warn, not error, since that case is harmless.
      log.warn(
        { shop, shopId: store.shop_id, status: gqlResponse.status, errors: gqlJson.errors, userErrors },
        "web pixel activation: webPixelCreate did not succeed cleanly",
      );
      return false;
    }
    log.info(
      { shop, shopId: store.shop_id, webPixelId: gqlJson.data?.webPixelCreate?.webPixel?.id },
      "web pixel activation: web pixel activated",
    );
    return true;
  } catch (error) {
    log.error({ shop, error }, "web pixel activation: webPixelCreate threw");
    return false;
  }
}
