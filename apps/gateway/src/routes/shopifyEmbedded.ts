import type { FastifyInstance } from "fastify";
import { getPixelApps, activateWebPixel, type PixelAppDef } from "../lib/webPixelActivation.js";

/**
 * The route that actually fires on a real install of an `embedded = true`
 * Web Pixel app — confirmed against Railway's own request logs on the
 * real Hub install (2026-09-06): Shopify never redirected to this app's
 * `[auth] redirect_urls` (routes/shopifyOauth.ts's classic
 * authorization-code callback) at all. Instead, right after the merchant
 * clicked "Instalar", it loaded `application_url` (this Gateway's bare
 * root) directly with `embedded=1` and a session `id_token` — Shopify's
 * "token exchange" flow, documented at
 * shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange
 * as what embedded apps use instead of a redirect: "exchange an ID token
 * for an access token, without redirecting the merchant." The classic
 * callback is kept as a fallback for any flow that still uses it, but
 * this route is the one this project's two pixel apps actually need.
 */

interface SessionTokenPayload {
  iss?: string;
  dest?: string;
  aud?: string;
  exp?: number;
  nbf?: number;
}

function base64UrlDecode(input: string): Buffer | null {
  try {
    return Buffer.from(input, "base64url");
  } catch {
    return null;
  }
}

/** Peeks the JWT's `aud` claim WITHOUT verifying the signature yet — just
 * enough to know which of our two pixel apps' client secret to verify
 * against next. Never trusted on its own. */
function peekUnverifiedAudience(idToken: string): string | undefined {
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;
  const payloadPart = parts[1];
  if (!payloadPart) return undefined;
  const payloadBuf = base64UrlDecode(payloadPart);
  if (!payloadBuf) return undefined;
  try {
    const payload = JSON.parse(payloadBuf.toString("utf8")) as SessionTokenPayload;
    return payload.aud;
  } catch {
    return undefined;
  }
}

/** Sanity-checks a Shopify session token's claims: `exp`/`nbf` freshness
 * and that `dest`/`iss` actually name the `shop` this request claims to
 * be for. Deliberately does NOT attempt to verify the JWT's own HS256
 * signature — tested against a real token from a real install and found
 * that it is not a plain `HMAC-SHA256(header.payload, client_secret)` as
 * shopify.dev's token-exchange doc paraphrases it (every one of this
 * project's known client secrets and client IDs, tried as the HMAC key,
 * produced a signature that didn't match); getting a from-scratch
 * reimplementation of Shopify's exact signing scheme right without a
 * library is a real risk of silently rejecting legitimate installs.
 * That's an acceptable gap here because the token is never trusted on
 * its own: the next step exchanges it with Shopify's own
 * `/admin/oauth/access_token` endpoint, which does the authoritative
 * signature/authenticity check server-side — a forged or tampered token
 * simply fails that call and this route never reaches `webPixelCreate`.
 * This function only exists to fail fast on an obviously stale/mismatched
 * token before spending that network round-trip. */
function checkSessionTokenClaims(idToken: string, expectedShop: string): boolean {
  const parts = idToken.split(".");
  if (parts.length !== 3) return false;
  const payloadPart = parts[1];
  if (!payloadPart) return false;

  const payloadBuf = base64UrlDecode(payloadPart);
  if (!payloadBuf) return false;
  let payload: SessionTokenPayload;
  try {
    payload = JSON.parse(payloadBuf.toString("utf8")) as SessionTokenPayload;
  } catch {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) return false;
  if (typeof payload.nbf === "number" && payload.nbf > now) return false;

  const destHost = (payload.dest ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const issHost = (payload.iss ?? "").replace(/^https?:\/\//, "").replace(/\/admin$/, "");
  if (destHost !== expectedShop || issHost !== expectedShop) return false;

  return true;
}

interface TokenExchangeResult {
  accessToken: string | null;
  /** Populated only on failure — status + response body (never the
   * request body, which carries the client secret) — so the caller can
   * log enough to diagnose a bad exchange without a second round-trip. */
  failure?: { status: number; body: string };
}

async function exchangeToken(shop: string, app: PixelAppDef, idToken: string): Promise<TokenExchangeResult> {
  try {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: idToken,
        subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
        requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      return { accessToken: null, failure: { status: response.status, body: text } };
    }
    const json = JSON.parse(text) as { access_token?: string };
    if (!json.access_token) {
      return { accessToken: null, failure: { status: response.status, body: text } };
    }
    return { accessToken: json.access_token };
  } catch (error) {
    return { accessToken: null, failure: { status: 0, body: String(error) } };
  }
}

export async function registerShopifyEmbeddedRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const { embedded, id_token: idToken, shop } = query;

    if (embedded !== "1" || !idToken || !shop) {
      // Not an embedded-app bootstrap request — e.g. someone hitting the
      // bare Gateway root directly. Nothing to activate here.
      return reply.code(404).send({ error: "not_found" });
    }
    if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) {
      return reply.code(400).send({ error: "invalid_shop" });
    }

    const audience = peekUnverifiedAudience(idToken);
    const pixelApp = getPixelApps(app.config).find((candidate) => candidate.clientId === audience);
    if (!pixelApp) {
      app.log.warn({ shop, audience }, "shopify embedded bootstrap: unknown client_id in id_token");
      return reply.code(404).send({ error: "unknown_app" });
    }
    if (!checkSessionTokenClaims(idToken, shop)) {
      app.log.warn({ shop }, "shopify embedded bootstrap: session token failed claim checks");
      return reply.code(401).send({ error: "invalid_session_token" });
    }

    const exchangeResult = await exchangeToken(shop, pixelApp, idToken);
    if (!exchangeResult.accessToken) {
      // `failure.body` is Shopify's own error response — never our
      // request body, so this never logs the client secret.
      app.log.error({ shop, failure: exchangeResult.failure }, "shopify embedded bootstrap: token exchange failed");
      return reply.code(502).send({ error: "token_exchange_failed" });
    }
    const accessToken = exchangeResult.accessToken;

    await activateWebPixel(app.log, app.config, pixelApp, shop, accessToken);

    // Shopify only renders this inside the Admin iframe when it's allowed
    // to frame it — @fastify/helmet's global defaults (server.ts) set
    // X-Frame-Options: SAMEORIGIN and a same-origin frame-ancestors CSP,
    // which block that by default, so this route overrides both for
    // this specific shop's admin origin.
    reply.header("Content-Security-Policy", `frame-ancestors https://${shop} https://admin.shopify.com;`);
    reply.removeHeader("X-Frame-Options");
    return reply.type("text/html").send(
      `<html><body style="font-family: sans-serif; padding: 2rem;"><h1>Tracking Platform Pixel instalado</h1><p>Pode voltar para a loja em Configurações &gt; Eventos de clientes.</p></body></html>`,
    );
  });
}
