import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  integer,
  numeric,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ============================================================
// Enums
// ============================================================

export const shopRoleEnum = pgEnum("shop_role", ["storefront", "checkout"]);

export const eventSourceEnum = pgEnum("event_source", ["browser", "server", "webhook"]);

export const linkConfidenceEnum = pgEnum("link_confidence", [
  "DETERMINISTIC",
  "PROBABILISTIC",
  "UNKNOWN",
]);

export const transferStatusEnum = pgEnum("transfer_status", [
  "pending",
  "redeemed",
  "expired",
  "replay_detected",
]);

/** Purchase state machine — spec section 22. */
export const purchaseStateEnum = pgEnum("purchase_state", [
  "CHECKOUT_STARTED",
  "ORDER_CREATED",
  "PAYMENT_PENDING",
  "PAID",
  "PURCHASE_RECORDED",
  "META_DELIVERED",
  "CANCELLED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
  "FAILED",
]);

// ============================================================
// Identity
// ============================================================

/** A visitor: the top-level first-party identity (`tracking_id`). */
export const visitors = pgTable("visitors", {
  trackingId: uuid("tracking_id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  firstSeenShopId: text("first_seen_shop_id"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
});

/** A session belongs to exactly one visitor; a visitor can have many sessions
 * (never confuse the two — see docs/ARCHITECTURE.md section 4/E). */
export const sessions = pgTable(
  "sessions",
  {
    sessionId: uuid("session_id").primaryKey().defaultRandom(),
    trackingId: uuid("tracking_id")
      .notNull()
      .references(() => visitors.trackingId),
    shopId: text("shop_id").notNull(),
    shopRole: shopRoleEnum("shop_role").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    landingPage: text("landing_page"),
    referrer: text("referrer"),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
  },
  (table) => [index("sessions_tracking_id_idx").on(table.trackingId)],
);

/** Every ad-relevant visit becomes an independent, immutable touch — never
 * overwritten. Enables reconstructing FIRST/LAST/LAST_NON_DIRECT/LAST_PAID
 * touch models retroactively. */
export const attributionTouches = pgTable(
  "attribution_touches",
  {
    touchId: uuid("touch_id").primaryKey().defaultRandom(),
    trackingId: uuid("tracking_id")
      .notNull()
      .references(() => visitors.trackingId),
    sessionId: uuid("session_id").references(() => sessions.sessionId),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source"),
    medium: text("medium"),
    campaign: text("campaign"),
    campaignId: text("campaign_id"),
    adsetId: text("adset_id"),
    adId: text("ad_id"),
    fbclid: text("fbclid"),
    fbc: text("fbc"),
    fbp: text("fbp"),
    /** Google Ads' own click id (auto-tagged onto the landing URL the same
     * way Meta appends `fbclid` — see pixel-kit's `captureAttribution` for
     * the capture point). Stored starting now even though no Google Ads
     * campaign is live yet and nothing downstream sends it anywhere:
     * a click that happens before this column existed can never be
     * recovered later, so capturing it early is the only way historical
     * data will exist once Google Ads is actually turned on. */
    gclid: text("gclid"),
    landingPage: text("landing_page"),
    referrer: text("referrer"),
    isPaid: boolean("is_paid").notNull().default(false),
  },
  (table) => [
    index("attribution_touches_tracking_id_ts_idx").on(table.trackingId, table.occurredAt),
  ],
);

// ============================================================
// Cross-domain bridge (Store A -> Store B)
// ============================================================

export const transfers = pgTable(
  "transfers",
  {
    transferId: uuid("transfer_id").primaryKey().defaultRandom(),
    /** SHA-256 hash of the opaque token — the raw token is never stored. */
    tokenHash: text("token_hash").notNull(),
    sourceTrackingId: uuid("source_tracking_id")
      .notNull()
      .references(() => visitors.trackingId),
    sourceSessionId: uuid("source_session_id")
      .notNull()
      .references(() => sessions.sessionId),
    /** Which destination (checkout) store this specific transfer targets —
     * NOT a global Gateway setting. A Hub storefront can route different
     * products/clicks to different destination stores (each its own
     * Shopify store/domain/Shopify Payments account); `GET /r/:token`
     * resolves the redirect domain from THIS field via the
     * `SHOPIFY_STORES` registry (config.ts), never a single hardcoded
     * domain. See docs/PHASE_LOG.md's "Correção de Arquitetura — Multi-Loja
     * de Destino" entry for why this was added after Phase 11. */
    destinationShopId: text("destination_shop_id").notNull(),
    // No FK to `sessions` on purpose: Store B's Web Pixel may call redeem
    // in a race with (or slightly ahead of) the page_viewed event that
    // creates the session row, since both are independent, asynchronous
    // client-originated calls. Redeem must never fail — or worse, silently
    // drop the cross-domain link — just because of ordering between two
    // fire-and-forget requests. Consistent with `identity_links`, which
    // also references sessions/visitors by value, not by FK.
    redeemedSessionId: uuid("redeemed_session_id"),
    nonce: text("nonce").notNull(),
    cartSnapshot: jsonb("cart_snapshot"),
    status: transferStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("transfers_token_hash_idx").on(table.tokenHash)],
);

// ============================================================
// Commerce (Store B)
// ============================================================

export const checkouts = pgTable("checkouts", {
  checkoutToken: text("checkout_token").primaryKey(),
  sessionId: uuid("session_id").references(() => sessions.sessionId),
  cartToken: text("cart_token"),
  shopId: text("shop_id").notNull(),
  shopifyCustomerId: text("shopify_customer_id"),
  currency: text("currency"),
  presentmentCurrency: text("presentment_currency"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orders = pgTable(
  "orders",
  {
    orderId: text("order_id").primaryKey(),
    shopId: text("shop_id").notNull(),
    // No FK to `checkouts` on purpose (same pattern as
    // `transfers.redeemedSessionId` — see migration 0001): the Order
    // webhook is delivered server-to-server by Shopify Admin API,
    // independently of whether Store B's Web Pixel ever recorded a
    // `checkouts` row for that `checkout_token` (ad blockers, JS disabled,
    // consent decline, or simply a race where the webhook arrives first
    // all mean that row may be late or may never exist). Order ingestion
    // treats this correlation as best-effort and must never be blocked by
    // it (see apps/gateway/src/lib/orderIngestion.ts) — a hard FK would
    // silently defeat that by rejecting the insert outright.
    checkoutToken: text("checkout_token"),
    financialStatus: text("financial_status"),
    fulfillmentStatus: text("fulfillment_status"),
    currency: text("currency"),
    presentmentCurrency: text("presentment_currency"),
    totalAmount: numeric("total_amount", { precision: 12, scale: 2 }),
    state: purchaseStateEnum("state").notNull().default("ORDER_CREATED"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (table) => [index("orders_checkout_token_idx").on(table.checkoutToken)],
);

export const payments = pgTable("payments", {
  paymentId: text("payment_id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.orderId),
  status: text("status"),
  gateway: text("gateway"),
  amount: numeric("amount", { precision: 12, scale: 2 }),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});

export const refunds = pgTable("refunds", {
  refundId: text("refund_id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.orderId),
  amount: numeric("amount", { precision: 12, scale: 2 }),
  reason: text("reason"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// Events / dedup / delivery
// ============================================================

/** Raw event archive — kept within retention policy for diagnostics
 * (spec section 29). Payload is the already-validated TrackingEventV1;
 * sensitive fields are redacted before persistence per the Data Vault
 * design (section 25), never stored raw here. */
export const events = pgTable(
  "events",
  {
    eventId: text("event_id").primaryKey(),
    eventName: text("event_name").notNull(),
    schemaVersion: text("schema_version").notNull(),
    trackingId: uuid("tracking_id"),
    sessionId: uuid("session_id"),
    shopId: text("shop_id"),
    sourceOrigin: eventSourceEnum("source_origin").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    validationStatus: text("validation_status").notNull(),
    processingStatus: text("processing_status").notNull().default("received"),
  },
  (table) => [index("events_tracking_id_idx").on(table.trackingId)],
);

/** Local dedup ledger consulted BEFORE anything is sent to Meta —
 * independent of Meta's own 48h Pixel/CAPI dedup window (spec section 13). */
export const eventRegistry = pgTable("event_registry", {
  eventId: text("event_id").primaryKey(),
  eventName: text("event_name").notNull(),
  trackingId: uuid("tracking_id"),
  sessionId: uuid("session_id"),
  sourceOrigin: eventSourceEnum("source_origin").notNull(),
  firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
  browserReceived: boolean("browser_received").notNull().default(false),
  serverReceived: boolean("server_received").notNull().default(false),
  metaSent: boolean("meta_sent").notNull().default(false),
  status: text("status").notNull().default("pending"),
});

export const metaDeliveries = pgTable("meta_deliveries", {
  deliveryId: uuid("delivery_id").primaryKey().defaultRandom(),
  eventId: text("event_id")
    .notNull()
    .references(() => eventRegistry.eventId),
  requestTs: timestamp("request_ts", { withTimezone: true }).notNull().defaultNow(),
  httpStatus: integer("http_status"),
  /** Meta's response, with `access_token`/secrets never present in the first
   * place (spec section 41 — access tokens/secrets must never be logged). */
  responseRedacted: jsonb("response_redacted"),
  attemptCount: integer("attempt_count").notNull().default(0),
  deliveryStatus: text("delivery_status").notNull().default("pending"),
  /** A snapshot of `custom_data.value`/`custom_data.currency` from the
   * EXACT event this delivery attempt sent — never re-derived from the
   * `orders` row at read time, because `orders` can legitimately change
   * after the send (e.g. a later, corrected webhook delivery). This is
   * what lets the Reconciliation Engine (Phase 12) detect a genuine
   * VALUE_MISMATCH/CURRENCY_MISMATCH — comparing what Meta was actually
   * told against the CURRENT `orders` row — without fabricating a
   * comparison against data this table never captured. */
  valueSent: numeric("value_sent", { precision: 12, scale: 2 }),
  currencySent: text("currency_sent"),
});

// ============================================================
// Identity Graph
// ============================================================

export const identityLinks = pgTable(
  "identity_links",
  {
    linkId: uuid("link_id").primaryKey().defaultRandom(),
    entityAType: text("entity_a_type").notNull(),
    entityAValue: text("entity_a_value").notNull(),
    entityBType: text("entity_b_type").notNull(),
    entityBValue: text("entity_b_value").notNull(),
    confidence: linkConfidenceEnum("confidence").notNull(),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("identity_links_unique_edge_idx").on(
      table.entityAType,
      table.entityAValue,
      table.entityBType,
      table.entityBValue,
    ),
    index("identity_links_entity_a_idx").on(table.entityAType, table.entityAValue),
    index("identity_links_entity_b_idx").on(table.entityBType, table.entityBValue),
  ],
);

/** PII vault, physically separate from `events`/`attribution_touches`
 * (spec section 25). Values here are hashes (Meta-ready SHA-256) or
 * application-level encrypted blobs — never plaintext. */
export const identityPrivate = pgTable("identity_private", {
  trackingId: uuid("tracking_id")
    .primaryKey()
    .references(() => visitors.trackingId),
  emailHash: text("email_hash"),
  phoneHash: text("phone_hash"),
  firstNameEnc: text("first_name_enc"),
  lastNameEnc: text("last_name_enc"),
  addressEnc: text("address_enc"),
  encryptedAt: timestamp("encrypted_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// Consent / privacy
// ============================================================

export const consentStates = pgTable("consent_states", {
  consentId: uuid("consent_id").primaryKey().defaultRandom(),
  shopId: text("shop_id").notNull(),
  sessionId: uuid("session_id").references(() => sessions.sessionId),
  analyticsProcessingAllowed: boolean("analytics_processing_allowed"),
  marketingAllowed: boolean("marketing_allowed"),
  preferencesProcessingAllowed: boolean("preferences_processing_allowed"),
  saleOfDataAllowed: boolean("sale_of_data_allowed"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// Webhooks / reconciliation / audit
// ============================================================

export const webhookReceipts = pgTable(
  "webhook_receipts",
  {
    receiptId: uuid("receipt_id").primaryKey().defaultRandom(),
    shopId: text("shop_id").notNull(),
    topic: text("topic").notNull(),
    webhookId: text("webhook_id").notNull(),
    hmacValid: boolean("hmac_valid").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processingStatus: text("processing_status").notNull().default("received"),
  },
  (table) => [uniqueIndex("webhook_receipts_shop_webhook_idx").on(table.shopId, table.webhookId)],
);

export const reconciliationRuns = pgTable("reconciliation_runs", {
  runId: uuid("run_id").primaryKey().defaultRandom(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  matched: integer("matched").notNull().default(0),
  missingLocal: integer("missing_local").notNull().default(0),
  missingMeta: integer("missing_meta").notNull().default(0),
  duplicated: integer("duplicated").notNull().default(0),
  valueMismatch: integer("value_mismatch").notNull().default(0),
  currencyMismatch: integer("currency_mismatch").notNull().default(0),
  unattributed: integer("unattributed").notNull().default(0),
});

// ============================================================
// Queue / Dead Letter (Phase 11)
// ============================================================

/**
 * Durable, queryable record of a queued job (Meta CAPI send, so far) that
 * could not be delivered — either because retrying it will never help
 * (consent not granted, a journey-resolution gap, a permanent Meta error
 * like an invalid/expired access token) or because it exhausted its
 * configured retry attempts against a transient error. This lives in
 * Postgres, not just BullMQ's own Redis-backed failed set, specifically so
 * the Reconciliation Engine (Phase 12) — which already queries Postgres,
 * never Redis — can find and act on it (spec section J: "Dead Letter Queue
 * para erros permanentes ... separados de erros retryable").
 *
 * `(queue_name, job_id)` is unique: a second failure of the same logical
 * job (e.g. a manual replay that fails again) updates `failure_reason`/
 * `attempts_made`/`last_failed_at` in place rather than accumulating
 * duplicate rows for what is, semantically, still the same stuck job.
 */
export const deadLetters = pgTable(
  "dead_letters",
  {
    deadLetterId: uuid("dead_letter_id").primaryKey().defaultRandom(),
    queueName: text("queue_name").notNull(),
    jobId: text("job_id").notNull(),
    /** The job's own data payload — deliberately never contains secrets
     * (e.g. the Meta access token, resolved fresh from config at process
     * time, is never part of job data) so persisting it here is safe. */
    jobData: jsonb("job_data").notNull(),
    failureReason: text("failure_reason").notNull(),
    attemptsMade: integer("attempts_made").notNull(),
    firstFailedAt: timestamp("first_failed_at", { withTimezone: true }).notNull().defaultNow(),
    lastFailedAt: timestamp("last_failed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("dead_letters_queue_job_idx").on(table.queueName, table.jobId)],
);

export const auditLogs = pgTable("audit_logs", {
  logId: uuid("log_id").primaryKey().defaultRandom(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  metadataRedacted: jsonb("metadata_redacted"),
});
