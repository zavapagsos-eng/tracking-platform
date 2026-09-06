import { z } from "zod";

/**
 * One Shopify store this Gateway knows about — the Hub storefront
 * (`role: "storefront"`) or one of potentially several destination/
 * checkout stores (`role: "checkout"`). Real topology, confirmed directly
 * with the merchant rather than assumed from the original two-store
 * ("Store A"/"Store B") design: ONE Hub product catalog can send different
 * products' "buy" clicks to DIFFERENT destination stores — each its own
 * Shopify store, domain, and Shopify Payments account — chosen by data
 * already on the product in Shopify (a tag/metafield/collection the
 * merchant's theme reads). See docs/PHASE_LOG.md's "Correção de
 * Arquitetura — Multi-Loja de Destino" entry for the full finding.
 */
export const storeEntrySchema = z.object({
  /** Matches `TrackingEventV1.shop.shop_id` for this store's Web Pixel
   * installation, `transfers.destination_shop_id`, and the `:store` path
   * param on `/webhooks/:store/*`. */
  shop_id: z.string().min(1),
  /** Bare domain (no scheme), e.g. "loja-b1.myshopify.com" or a custom
   * domain — used to build the `GET /r/:token` redirect target for
   * whichever destination store a given transfer names. */
  domain: z.string().min(1),
  role: z.enum(["storefront", "checkout"]),
  /** This store's own Admin API webhook signing secret (per-store, since
   * each Shopify store that installs the tracking app gets its own webhook
   * subscriptions and its own secret) — used to verify
   * `X-Shopify-Hmac-Sha256` on `/webhooks/:store/*` for this shop_id.
   * Distinct from `SHOPIFY_APP_PROXY_SECRET` below, which stays a single
   * shared value on purpose (verified against shopify.dev: an App Proxy
   * request is signed with the app's one OAuth client secret, the same
   * value regardless of which shop the request came from — not a
   * per-installation secret). */
  webhook_secret: z.string().min(1),
  /** The store's real `*.myshopify.com` domain — always what the OAuth
   * callback's `shop` query param carries (see routes/shopifyOauth.ts),
   * which is NOT always the same as `domain` above (that field holds
   * whichever domain the merchant's webhook routing uses, a custom domain
   * for Hub/Alpha Tactical). Optional/backward-compatible: only needed for
   * stores that go through the Web Pixel app-install OAuth flow. */
  myshopify_domain: z.string().min(1).optional(),
});
export type StoreEntry = z.infer<typeof storeEntrySchema>;

/** Parses `SHOPIFY_STORES` (a JSON array) into validated `StoreEntry[]`,
 * rejecting duplicate `shop_id`s — two registry entries claiming the same
 * shop_id would make webhook/redirect routing for that store ambiguous. */
function parseStoresJson(raw: string, ctx: z.RefinementCtx): StoreEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SHOPIFY_STORES must be valid JSON" });
    return z.NEVER;
  }

  const result = z.array(storeEntrySchema).safeParse(parsed);
  if (!result.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `SHOPIFY_STORES: ${result.error.issues.map((i) => i.message).join("; ")}`,
    });
    return z.NEVER;
  }

  const seen = new Set<string>();
  for (const store of result.data) {
    if (seen.has(store.shop_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `SHOPIFY_STORES: duplicate shop_id "${store.shop_id}"`,
      });
      return z.NEVER;
    }
    seen.add(store.shop_id);
  }

  return result.data;
}

const configSchema = z.object({
  TRACKING_ENV: z.enum(["development", "staging", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  /** Not required by Phase 3 (queueing lands in Phase 11), kept optional so
   * the Gateway can boot without Redis during this phase. */
  REDIS_URL: z.string().optional(),
  GATEWAY_HMAC_SECRET: z.string().min(32, "GATEWAY_HMAC_SECRET must be at least 32 characters"),
  CORS_ALLOWLIST: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  TRANSFER_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  /** The installed app's client secret, used to verify Shopify App Proxy
   * request signatures on /proxy/* routes (see lib/appProxy.ts). ONE value
   * shared across every store the app is installed on (verified against
   * shopify.dev — App Proxy signing uses the app's single OAuth client
   * secret, not a per-shop one). Optional in this phase so the Gateway can
   * boot before a real app is registered; /proxy/* returns 501 until it's set. */
  SHOPIFY_APP_PROXY_SECRET: z.string().optional(),
  /**
   * The registry of every Shopify store this Gateway talks to — the Hub
   * storefront plus every destination/checkout store — as a JSON array of
   * `StoreEntry` (see the schema above for the full rationale). Optional
   * (defaults to `[]`) so the Gateway can boot before any real store is
   * configured; every store-aware route (`/webhooks/:store/*`,
   * `GET /r/:token`) fails closed — 404/500 with a clear error — for a
   * shop_id not present here, never a guessed fallback.
   *
   * Example: `[{"shop_id":"hub","domain":"hub.myshopify.com","role":"storefront","webhook_secret":"..."},
   * {"shop_id":"loja-b1","domain":"loja-b1.myshopify.com","role":"checkout","webhook_secret":"..."}]`
   */
  SHOPIFY_STORES: z
    .string()
    .optional()
    .transform((value, ctx) => (value ? parseStoresJson(value, ctx) : [])),
  /**
   * Meta Conversions API credentials (Phase 10). Research finding (see
   * docs/PHASE_LOG.md Phase 10): current Meta documentation describes the
   * `/events` endpoint's path identifier as a "dataset ID" ("server events
   * are linked to a dataset ID and processed like Pixel events"), which
   * for a plain web Pixel is the same numeric ID Events Manager still
   * labels "Pixel ID" — the terminology is mid-migration, not two
   * different values. Both env vars are accepted for that reason;
   * `META_DATASET_ID` wins when both are set, since it's the more current
   * name. Optional so the Gateway can boot before real Meta credentials
   * are connected — every Meta-send path checks for this at call time and
   * fails closed (never fabricated, never sent unconfigured).
   */
  META_PIXEL_ID: z.string().optional(),
  META_DATASET_ID: z.string().optional(),
  META_ACCESS_TOKEN: z.string().optional(),
  /** Root-level `test_event_code` (per Meta's documented request shape) —
   * when set, every outbound event carries it, routing delivery to Meta's
   * Test Events tool instead of production reporting. Must be unset for a
   * real production send; never faked in production traffic. */
  META_TEST_EVENT_CODE: z.string().optional(),
  /** Graph API version segment of the endpoint URL
   * (`https://graph.facebook.com/{version}/{id}/events`). Kept
   * configurable rather than hardcoded — see docs/PHASE_LOG.md Phase 10
   * for the currently-supported version range this default was chosen
   * from (Meta deprecates versions on a rolling ~2-year schedule). */
  META_API_VERSION: z.string().default("v23.0"),
  /**
   * Queue + retry configuration (Phase 11, docs/ARCHITECTURE.md section J:
   * "backoff exponencial + jitter, número máximo de tentativas
   * configurável"). Only takes effect when `REDIS_URL` is also set — like
   * the Meta credentials above, queueing fails closed (no queue/worker
   * constructed, never a silent partial one) rather than assuming a
   * default Redis is reachable.
   */
  META_QUEUE_ATTEMPTS: z.coerce.number().int().positive().default(5),
  META_QUEUE_BACKOFF_DELAY_MS: z.coerce.number().int().positive().default(5000),
  /** Fraction (0-1) of the computed exponential delay randomized away —
   * BullMQ's own `jitter` option (verified against its installed v6
   * `BackoffOptions` type, Phase 11 research), not a custom strategy. */
  META_QUEUE_BACKOFF_JITTER: z.coerce.number().min(0).max(1).default(0.2),
  /**
   * Reconciliation Engine (Phase 12, docs/ARCHITECTURE.md seção J/line 278).
   * `RECONCILIATION_CRON` (standard 5-field cron expression) is read by
   * `src/reconciliationCron.ts`, the standalone process that runs the scan
   * + bounded auto-requeue periodically — never by the HTTP Gateway itself.
   */
  RECONCILIATION_CRON: z.string().default("*/30 * * * *"),
  /** A PAID order with no Meta delivery attempt yet and no dead-letter row
   * is only flagged MISSING_META once it has been paid for longer than
   * this — a freshly paid order is normally just still waiting for its
   * BullMQ job to be picked up, not a real gap. */
  RECONCILIATION_STALE_AFTER_MINUTES: z.coerce.number().int().positive().default(15),
  /** Auto-requeue (via `queue.remove()` + `enqueuePurchaseSend()`, per the
   * jobId-reuse constraint documented in docs/PHASE_LOG.md Phase 11) is
   * bounded on both axes: never more than this many requeue attempts per
   * order (a permanently-broken order must eventually surface to a human
   * instead of retrying forever)... */
  RECONCILIATION_MAX_REQUEUE_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** ...and never sooner than this many minutes since the last failure —
   * avoids hammering Meta/the queue every 30 minutes for an order that
   * just failed permanently a minute ago. */
  RECONCILIATION_REQUEUE_COOLDOWN_MINUTES: z.coerce.number().int().positive().default(60),
  /**
   * Admin/Dashboard read-only API (Phase 13). HTTP Basic Auth against a
   * single operator account — not a real user system, matching this
   * project's own scope ("Admin/Dashboard (leitura)" in the architecture
   * diagram, spec section listing it as read-only). Optional so the
   * Gateway can boot before an admin password is provisioned; every
   * `/admin/*` route fails closed (401) until both are set, never open by
   * default and never falling back to a guessable default credential.
   */
  ADMIN_DASHBOARD_USERNAME: z.string().optional(),
  /** A bcrypt hash (e.g. via `npx bcryptjs-cli hash` or Node's bcryptjs),
   * never a plaintext password — compared with a constant-time bcrypt
   * compare, never a raw string equality check. */
  ADMIN_DASHBOARD_PASSWORD_HASH: z.string().optional(),
  /**
   * Web Pixel app OAuth activation (see routes/shopifyOauth.ts). Each
   * Shopify custom app can only ship ONE `web_pixel_extension` (a hard
   * Shopify platform limit, confirmed the hard way — see docs/PHASE_LOG.md
   * "Web Pixel — limite de 1 por app"), so this project ships TWO small
   * apps: "Store A" (installed only on the Hub) and "Store B" (installed
   * on every checkout-role destination store). Both pairs are optional so
   * the Gateway can boot before either app exists; the callback route
   * fails closed (404 unknown_app) for a client_id that doesn't match
   * either pair, never a guessed fallback.
   */
  PIXEL_APP_STORE_A_CLIENT_ID: z.string().optional(),
  PIXEL_APP_STORE_A_CLIENT_SECRET: z.string().optional(),
  PIXEL_APP_STORE_B_CLIENT_ID: z.string().optional(),
  PIXEL_APP_STORE_B_CLIENT_SECRET: z.string().optional(),
  /** This Gateway's own public base URL — used both as the `gateway_url`
   * Web Pixel setting (see routes/shopifyOauth.ts) and anywhere else the
   * Gateway needs to describe itself to a browser/theme. Optional so the
   * Gateway can boot before a public domain is provisioned; the OAuth
   * callback fails closed rather than shipping an empty gateway_url. */
  GATEWAY_PUBLIC_URL: z.string().optional(),
  /**
   * Non-secret overlay for `SHOPIFY_STORES` entries created before the
   * Web Pixel OAuth flow existed: a JSON object mapping `shop_id` ->
   * `myshopify_domain`, e.g. `{"hub":"tmeqdz-q1.myshopify.com"}`. Kept as
   * its own variable (rather than requiring every `SHOPIFY_STORES` entry
   * to be rewritten in place) specifically so adding a store's
   * myshopify_domain never requires re-typing that store's
   * `webhook_secret` — a real secret this deployment's operator may not
   * have in hand when only the domain mapping is what's missing. Applied
   * in `loadConfig` below; a `myshopify_domain` already present on the
   * `SHOPIFY_STORES` entry itself always wins. */
  SHOPIFY_MYSHOPIFY_DOMAINS: z.string().optional(),
});

export type GatewayConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid Gateway configuration: ${details}`);
  }

  if (result.data.SHOPIFY_MYSHOPIFY_DOMAINS) {
    let domainMap: Record<string, string> = {};
    try {
      domainMap = JSON.parse(result.data.SHOPIFY_MYSHOPIFY_DOMAINS) as Record<string, string>;
    } catch {
      throw new Error("Invalid Gateway configuration: SHOPIFY_MYSHOPIFY_DOMAINS must be valid JSON");
    }
    result.data.SHOPIFY_STORES = result.data.SHOPIFY_STORES.map((store) => ({
      ...store,
      myshopify_domain: store.myshopify_domain ?? domainMap[store.shop_id],
    }));
  }

  return result.data;
}

/** Looks up one store's registry entry by `shop_id` — the single place
 * every store-aware route (`/webhooks/:store/*`, `GET /r/:token`) resolves
 * a domain/webhook secret from, so there is exactly one source of truth
 * for "which stores does this Gateway know about." Returns `undefined` for
 * an unregistered shop_id — callers must fail closed, never guess. */
export function findStoreByShopId(config: GatewayConfig, shopId: string): StoreEntry | undefined {
  return config.SHOPIFY_STORES.find((store) => store.shop_id === shopId);
}

/** Looks up a store by its real `*.myshopify.com` domain — the only form
 * of "which store is this" the Shopify OAuth callback ever hands us (see
 * routes/shopifyOauth.ts). Falls back to matching `domain` too, since a
 * store whose webhook-routing `domain` already IS its myshopify domain
 * (e.g. Rugged destino, which has no separate custom domain) never needs
 * `myshopify_domain` set separately. */
export function findStoreByMyshopifyDomain(config: GatewayConfig, shop: string): StoreEntry | undefined {
  return config.SHOPIFY_STORES.find((store) => store.myshopify_domain === shop || store.domain === shop);
}
