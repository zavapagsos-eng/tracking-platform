import type { NormalizedMetaUserData } from "./metaNormalization.js";
import type { GatewayConfig } from "../config.js";

/**
 * Endpoint shape verified against Meta's official Conversions API docs
 * (developers.facebook.com/docs/marketing-api/conversions-api/using-the-api,
 * Phase 10 research):
 *   POST https://graph.facebook.com/{API_VERSION}/{PIXEL_OR_DATASET_ID}/events?access_token={TOKEN}
 *   body: { data: [ { event_name, event_time, event_id, event_source_url,
 *                      action_source, user_data, custom_data } ],
 *           test_event_code?: string }
 * `event_time` is Unix seconds (not milliseconds).
 */
export interface MetaCapiCustomData {
  currency?: string;
  value?: number;
  order_id?: string;
  content_ids?: string[];
  content_type?: string;
  num_items?: number;
}

export interface MetaCapiEvent {
  event_name: string;
  /** Unix seconds. */
  event_time: number;
  event_id: string;
  event_source_url?: string;
  action_source: "website";
  user_data: NormalizedMetaUserData;
  custom_data?: MetaCapiCustomData;
}

export interface MetaCapiCredentials {
  /** The dataset/pixel id used in the endpoint path — see config.ts for
   * why either `META_DATASET_ID` or `META_PIXEL_ID` is accepted upstream;
   * by the time it reaches this client it's already resolved to one id. */
  datasetId: string;
  accessToken: string;
  apiVersion: string;
  testEventCode?: string;
}

export type MetaCapiSendResult =
  | { status: "sent"; httpStatus: number; responseRedacted: unknown }
  | { status: "http_error"; httpStatus: number; responseRedacted: unknown }
  | { status: "network_error"; error: string };

/**
 * Resolves `GatewayConfig`'s separate `META_PIXEL_ID`/`META_DATASET_ID`/
 * `META_ACCESS_TOKEN`/`META_API_VERSION`/`META_TEST_EVENT_CODE` fields into
 * a single `MetaCapiCredentials` object — the one place that implements
 * the "META_DATASET_ID wins when both are set" rule documented in
 * config.ts and .env.example (see the terminology-ambiguity research note
 * there: Meta's current docs call the /events path id a "dataset id",
 * Events Manager still often labels the same numeric id "Pixel ID").
 *
 * Returns `undefined` — never a partially-built/fabricated credentials
 * object — when Meta isn't configured yet: no access token, or neither id
 * is set. This mirrors the established pattern elsewhere in this codebase
 * for optional external integrations (e.g. SHOPIFY_APP_PROXY_SECRET) that
 * gate a no-op/501 until real credentials are connected, rather than ever
 * sending with a missing/empty value.
 */
export function resolveMetaCredentials(config: GatewayConfig): MetaCapiCredentials | undefined {
  const datasetId = config.META_DATASET_ID || config.META_PIXEL_ID;
  if (!datasetId || !config.META_ACCESS_TOKEN) {
    return undefined;
  }
  return {
    datasetId,
    accessToken: config.META_ACCESS_TOKEN,
    apiVersion: config.META_API_VERSION,
    testEventCode: config.META_TEST_EVENT_CODE,
  };
}

/**
 * Sends one event to Meta CAPI. Deliberately takes exactly one event per
 * call (not a batch) — Phase 11's queue/worker is what will call this once
 * per queued job, and keeping the unit of work here at "one event" means
 * a single failure never risks a whole batch's delivery/retry state.
 *
 * NEVER logs `credentials.accessToken` — it's used only to build the
 * request URL, never included in any thrown error, log line, or the
 * returned result (spec section 41: access tokens/secrets must never be
 * logged). The raw Meta response is not redacted by this function itself
 * (Meta's own response body doesn't echo the token back), but callers
 * persisting it (see `meta_deliveries.response_redacted`) are expected to
 * still treat it as "redacted" terminology throughout, per the same rule.
 */
export async function sendMetaCapiEvent(
  event: MetaCapiEvent,
  credentials: MetaCapiCredentials,
): Promise<MetaCapiSendResult> {
  const url = new URL(
    `https://graph.facebook.com/${credentials.apiVersion}/${credentials.datasetId}/events`,
  );
  url.searchParams.set("access_token", credentials.accessToken);

  const body: { data: MetaCapiEvent[]; test_event_code?: string } = { data: [event] };
  if (credentials.testEventCode) {
    body.test_event_code = credentials.testEventCode;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    // Defense in depth (Phase 15 security review finding): `url` carries
    // `access_token` as a query parameter (the documented Meta CAPI auth
    // scheme — there is no header-based alternative), and some fetch
    // implementations embed the failed request's full URL in a network
    // error's message/cause chain. This result is returned to callers that
    // persist it (`dead_letters.failure_reason`, Phase 11/12) and may reach
    // logs — so the token is stripped here even though this codebase never
    // observed it appear in practice, rather than trusting the runtime's
    // error message shape to stay that way (spec section 41: access
    // tokens/secrets must never be logged).
    const sanitizedMessage = rawMessage.split(credentials.accessToken).join("[REDACTED]");
    return { status: "network_error", error: sanitizedMessage };
  }

  let responseJson: unknown;
  try {
    responseJson = await response.json();
  } catch {
    responseJson = null;
  }

  if (!response.ok) {
    return { status: "http_error", httpStatus: response.status, responseRedacted: responseJson };
  }
  return { status: "sent", httpStatus: response.status, responseRedacted: responseJson };
}
