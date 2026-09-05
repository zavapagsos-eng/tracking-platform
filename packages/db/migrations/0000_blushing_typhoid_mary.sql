CREATE TYPE "public"."event_source" AS ENUM('browser', 'server', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."link_confidence" AS ENUM('DETERMINISTIC', 'PROBABILISTIC', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."purchase_state" AS ENUM('CHECKOUT_STARTED', 'ORDER_CREATED', 'PAYMENT_PENDING', 'PAID', 'PURCHASE_RECORDED', 'META_DELIVERED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."shop_role" AS ENUM('storefront', 'checkout');--> statement-breakpoint
CREATE TYPE "public"."transfer_status" AS ENUM('pending', 'redeemed', 'expired', 'replay_detected');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "attribution_touches" (
	"touch_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tracking_id" uuid NOT NULL,
	"session_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text,
	"medium" text,
	"campaign" text,
	"campaign_id" text,
	"adset_id" text,
	"ad_id" text,
	"fbclid" text,
	"fbc" text,
	"fbp" text,
	"landing_page" text,
	"referrer" text,
	"is_paid" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"log_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata_redacted" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "checkouts" (
	"checkout_token" text PRIMARY KEY NOT NULL,
	"session_id" uuid,
	"cart_token" text,
	"shop_id" text NOT NULL,
	"shopify_customer_id" text,
	"currency" text,
	"presentment_currency" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consent_states" (
	"consent_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" text NOT NULL,
	"session_id" uuid,
	"analytics_processing_allowed" boolean,
	"marketing_allowed" boolean,
	"preferences_processing_allowed" boolean,
	"sale_of_data_allowed" boolean,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_registry" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_name" text NOT NULL,
	"tracking_id" uuid,
	"session_id" uuid,
	"source_origin" "event_source" NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"browser_received" boolean DEFAULT false NOT NULL,
	"server_received" boolean DEFAULT false NOT NULL,
	"meta_sent" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_name" text NOT NULL,
	"schema_version" text NOT NULL,
	"tracking_id" uuid,
	"session_id" uuid,
	"shop_id" text,
	"source_origin" "event_source" NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validation_status" text NOT NULL,
	"processing_status" text DEFAULT 'received' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "identity_links" (
	"link_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_a_type" text NOT NULL,
	"entity_a_value" text NOT NULL,
	"entity_b_type" text NOT NULL,
	"entity_b_value" text NOT NULL,
	"confidence" "link_confidence" NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "identity_private" (
	"tracking_id" uuid PRIMARY KEY NOT NULL,
	"email_hash" text,
	"phone_hash" text,
	"first_name_enc" text,
	"last_name_enc" text,
	"address_enc" text,
	"encrypted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meta_deliveries" (
	"delivery_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"request_ts" timestamp with time zone DEFAULT now() NOT NULL,
	"http_status" integer,
	"response_redacted" jsonb,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"delivery_status" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"order_id" text PRIMARY KEY NOT NULL,
	"shop_id" text NOT NULL,
	"checkout_token" text,
	"financial_status" text,
	"fulfillment_status" text,
	"currency" text,
	"presentment_currency" text,
	"total_amount" numeric(12, 2),
	"state" "purchase_state" DEFAULT 'ORDER_CREATED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payments" (
	"payment_id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"status" text,
	"gateway" text,
	"amount" numeric(12, 2),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconciliation_runs" (
	"run_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"matched" integer DEFAULT 0 NOT NULL,
	"missing_local" integer DEFAULT 0 NOT NULL,
	"missing_meta" integer DEFAULT 0 NOT NULL,
	"duplicated" integer DEFAULT 0 NOT NULL,
	"value_mismatch" integer DEFAULT 0 NOT NULL,
	"currency_mismatch" integer DEFAULT 0 NOT NULL,
	"unattributed" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "refunds" (
	"refund_id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"amount" numeric(12, 2),
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"session_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tracking_id" uuid NOT NULL,
	"shop_id" text NOT NULL,
	"shop_role" "shop_role" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_event_at" timestamp with time zone,
	"landing_page" text,
	"referrer" text,
	"user_agent" text,
	"ip_address" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transfers" (
	"transfer_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"source_tracking_id" uuid NOT NULL,
	"source_session_id" uuid NOT NULL,
	"redeemed_session_id" uuid,
	"nonce" text NOT NULL,
	"cart_snapshot" jsonb,
	"status" "transfer_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "visitors" (
	"tracking_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_seen_shop_id" text,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_receipts" (
	"receipt_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" text NOT NULL,
	"topic" text NOT NULL,
	"webhook_id" text NOT NULL,
	"hmac_valid" boolean NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_status" text DEFAULT 'received' NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attribution_touches" ADD CONSTRAINT "attribution_touches_tracking_id_visitors_tracking_id_fk" FOREIGN KEY ("tracking_id") REFERENCES "public"."visitors"("tracking_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attribution_touches" ADD CONSTRAINT "attribution_touches_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "consent_states" ADD CONSTRAINT "consent_states_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "identity_private" ADD CONSTRAINT "identity_private_tracking_id_visitors_tracking_id_fk" FOREIGN KEY ("tracking_id") REFERENCES "public"."visitors"("tracking_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "meta_deliveries" ADD CONSTRAINT "meta_deliveries_event_id_event_registry_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event_registry"("event_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_checkout_token_checkouts_checkout_token_fk" FOREIGN KEY ("checkout_token") REFERENCES "public"."checkouts"("checkout_token") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("order_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("order_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tracking_id_visitors_tracking_id_fk" FOREIGN KEY ("tracking_id") REFERENCES "public"."visitors"("tracking_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transfers" ADD CONSTRAINT "transfers_source_tracking_id_visitors_tracking_id_fk" FOREIGN KEY ("source_tracking_id") REFERENCES "public"."visitors"("tracking_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transfers" ADD CONSTRAINT "transfers_source_session_id_sessions_session_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("session_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transfers" ADD CONSTRAINT "transfers_redeemed_session_id_sessions_session_id_fk" FOREIGN KEY ("redeemed_session_id") REFERENCES "public"."sessions"("session_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attribution_touches_tracking_id_ts_idx" ON "attribution_touches" USING btree ("tracking_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_tracking_id_idx" ON "events" USING btree ("tracking_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identity_links_unique_edge_idx" ON "identity_links" USING btree ("entity_a_type","entity_a_value","entity_b_type","entity_b_value");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_links_entity_a_idx" ON "identity_links" USING btree ("entity_a_type","entity_a_value");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_links_entity_b_idx" ON "identity_links" USING btree ("entity_b_type","entity_b_value");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_checkout_token_idx" ON "orders" USING btree ("checkout_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_tracking_id_idx" ON "sessions" USING btree ("tracking_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transfers_token_hash_idx" ON "transfers" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_receipts_shop_webhook_idx" ON "webhook_receipts" USING btree ("shop_id","webhook_id");