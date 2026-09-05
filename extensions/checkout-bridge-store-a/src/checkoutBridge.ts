/**
 * Checkout bridge — Store A side.
 *
 * NOT a Web Pixel (pixels can only observe events, never intercept a click
 * or redirect the page — see extensions/web-pixel-store-a). This module is
 * meant to be loaded by Store A's theme (e.g. as a small asset included via
 * a Theme App Extension app-embed block, or a snippet a developer wires
 * into the theme's "Buy now" / "Checkout" button) and run on click, BEFORE
 * the browser navigates to Store B.
 *
 * It creates a cross-domain transfer (spec section 9/10) via the App-Proxy
 * authenticated endpoint — never a client-embedded secret — and only then
 * sends the customer onward. It is intentionally fail-open: if the Gateway
 * is slow or unreachable, the customer still reaches checkout, just
 * without the A→B attribution link (spec section 50 — tracking must never
 * block a sale).
 *
 * Packaging this as an actual Theme App Extension block (blocks.toml,
 * liquid schema) needs the merchant's real theme to wire the button
 * selector against — left as an integration step for Phase 16 / the
 * merchant's developer. See snippets/buy-on-store-b.liquid.example for a
 * worked example of how a theme would call this.
 */

export interface ShopifyAjaxCartItem {
  id?: number | string;
  variant_id?: number | string;
  quantity: number;
}

export interface ShopifyAjaxCart {
  items: ShopifyAjaxCartItem[];
}

export interface CartLine {
  variant_id: string;
  quantity: number;
}

/** Converts Shopify's public `/cart.js` AJAX Cart response into the shape
 * `/proxy/transfer/create` expects. Prefers `variant_id` when present;
 * falls back to `id` (older cart.js responses use `id` for the variant id
 * — both are documented Shopify Storefront AJAX API shapes, never guessed). */
export function shapeCartForTransfer(cart: ShopifyAjaxCart): CartLine[] {
  return cart.items
    .map((item) => {
      const variantId = item.variant_id ?? item.id;
      return variantId !== undefined
        ? { variant_id: String(variantId), quantity: item.quantity }
        : null;
    })
    .filter((line): line is CartLine => line !== null);
}

export interface InitiateTransferOptions {
  trackingId: string;
  sessionId: string;
  cart: ShopifyAjaxCart;
  /** Which destination (checkout) store this specific click should land on
   * — the Hub theme reads this from data already on the product in Shopify
   * (a tag/metafield/collection; the mapping itself lives on the merchant's
   * theme, not in this bridge) and passes it straight through. Must match a
   * `shop_id` registered in the Gateway's `SHOPIFY_STORES` config or
   * `/r/:token` will fail closed rather than guess a domain (see
   * docs/PHASE_LOG.md's "Correção de Arquitetura — Multi-Loja de Destino"). */
  destinationShopId: string;
  /** Same-origin App Proxy path Shopify forwards to the Gateway's
   * /proxy/transfer/create, e.g. "/apps/tracking". No secret is ever sent
   * from here — Shopify's edge signs the proxied request server-side. */
  appProxyBasePath: string;
  /** Public base URL of the Gateway itself (NOT the app proxy path) —
   * needed because /r/:token is a Gateway-hosted route, not a Store A one. */
  gatewayPublicUrl: string;
  /** Where to send the customer if transfer creation fails or times out —
   * must still get them to Store B's checkout (fail-open). */
  fallbackCheckoutUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  redirect?: (url: string) => void;
}

const DEFAULT_TIMEOUT_MS = 1500;

/**
 * Creates the transfer and redirects the browser — to the tracked `/r/:token`
 * hop on success, or straight to the fallback checkout URL on any failure
 * or timeout. Never throws: a broken Gateway must never prevent a sale.
 */
export async function initiateTransferAndRedirect(options: InitiateTransferOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const redirect = options.redirect ?? ((url: string) => {
    window.location.href = url;
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${options.appProxyBasePath.replace(/\/$/, "")}/transfer/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tracking_id: options.trackingId,
        session_id: options.sessionId,
        destination_shop_id: options.destinationShopId,
        cart: shapeCartForTransfer(options.cart),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      redirect(options.fallbackCheckoutUrl);
      return;
    }

    const body = (await response.json()) as { redirect_path?: string };
    if (!body.redirect_path) {
      redirect(options.fallbackCheckoutUrl);
      return;
    }

    redirect(`${options.gatewayPublicUrl.replace(/\/$/, "")}${body.redirect_path}`);
  } catch {
    // Network error, timeout/abort, or malformed response — always still
    // send the customer to checkout.
    redirect(options.fallbackCheckoutUrl);
  } finally {
    clearTimeout(timer);
  }
}
