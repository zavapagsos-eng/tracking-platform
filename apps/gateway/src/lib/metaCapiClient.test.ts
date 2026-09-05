import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveMetaCredentials,
  sendMetaCapiEvent,
  type MetaCapiCredentials,
  type MetaCapiEvent,
} from "./metaCapiClient.js";
import type { GatewayConfig } from "../config.js";

const credentials: MetaCapiCredentials = {
  datasetId: "1234567890",
  accessToken: "super-secret-access-token",
  apiVersion: "v23.0",
  testEventCode: "TEST12345",
};

const event: MetaCapiEvent = {
  event_name: "Purchase",
  event_time: 1_700_000_000,
  event_id: "purchase:store-b:o1",
  action_source: "website",
  user_data: { em: "hash1", fbc: "fb.1.1.click1" },
  custom_data: { currency: "BRL", value: 99.9, order_id: "o1" },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Minimal valid base config — only the Meta-related fields vary per test. */
function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    TRACKING_ENV: "development",
    PORT: 3000,
    LOG_LEVEL: "info",
    DATABASE_URL: "postgresql://localhost/test",
    GATEWAY_HMAC_SECRET: "a".repeat(32),
    CORS_ALLOWLIST: [],
    TRANSFER_TOKEN_TTL_SECONDS: 600,
    SHOPIFY_STORES: [],
    META_API_VERSION: "v23.0",
    META_QUEUE_ATTEMPTS: 5,
    META_QUEUE_BACKOFF_DELAY_MS: 5000,
    META_QUEUE_BACKOFF_JITTER: 0.2,
    RECONCILIATION_CRON: "*/30 * * * *",
    RECONCILIATION_STALE_AFTER_MINUTES: 15,
    RECONCILIATION_MAX_REQUEUE_ATTEMPTS: 5,
    RECONCILIATION_REQUEUE_COOLDOWN_MINUTES: 60,
    ...overrides,
  };
}

describe("resolveMetaCredentials", () => {
  it("returns undefined when nothing is configured", () => {
    expect(resolveMetaCredentials(baseConfig())).toBeUndefined();
  });

  it("returns undefined when an id is set but the access token is missing", () => {
    expect(resolveMetaCredentials(baseConfig({ META_DATASET_ID: "d1" }))).toBeUndefined();
  });

  it("returns undefined when the access token is set but neither id is present", () => {
    expect(resolveMetaCredentials(baseConfig({ META_ACCESS_TOKEN: "tok" }))).toBeUndefined();
  });

  it("resolves using META_PIXEL_ID when only that is set", () => {
    const result = resolveMetaCredentials(baseConfig({ META_PIXEL_ID: "pixel1", META_ACCESS_TOKEN: "tok" }));
    expect(result).toEqual({ datasetId: "pixel1", accessToken: "tok", apiVersion: "v23.0", testEventCode: undefined });
  });

  it("resolves using META_DATASET_ID when only that is set", () => {
    const result = resolveMetaCredentials(baseConfig({ META_DATASET_ID: "dataset1", META_ACCESS_TOKEN: "tok" }));
    expect(result).toEqual({ datasetId: "dataset1", accessToken: "tok", apiVersion: "v23.0", testEventCode: undefined });
  });

  it("prefers META_DATASET_ID over META_PIXEL_ID when both are set", () => {
    const result = resolveMetaCredentials(
      baseConfig({ META_PIXEL_ID: "pixel1", META_DATASET_ID: "dataset1", META_ACCESS_TOKEN: "tok" }),
    );
    expect(result?.datasetId).toBe("dataset1");
  });

  it("passes through the configured API version and test event code", () => {
    const result = resolveMetaCredentials(
      baseConfig({
        META_DATASET_ID: "dataset1",
        META_ACCESS_TOKEN: "tok",
        META_API_VERSION: "v24.0",
        META_TEST_EVENT_CODE: "TEST999",
      }),
    );
    expect(result).toEqual({
      datasetId: "dataset1",
      accessToken: "tok",
      apiVersion: "v24.0",
      testEventCode: "TEST999",
    });
  });
});

describe("sendMetaCapiEvent", () => {
  it("POSTs to the documented endpoint shape with the access_token as a query param, never in the body", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ events_received: 1, fbtrace_id: "abc123" }), { status: 200 }),
    );

    const result = await sendMetaCapiEvent(event, credentials);

    expect(result.status).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [URL, RequestInit];

    expect(calledUrl.toString()).toBe(
      `https://graph.facebook.com/v23.0/1234567890/events?access_token=${credentials.accessToken}`,
    );
    expect(calledInit.method).toBe("POST");

    const sentBody = JSON.parse(calledInit.body as string);
    expect(sentBody).toEqual({ data: [event], test_event_code: "TEST12345" });
    // The access token must never appear anywhere in the request BODY —
    // only in the URL, which Meta's own documented contract requires.
    expect(calledInit.body as string).not.toContain(credentials.accessToken);
  });

  it("omits test_event_code from the body when not configured (never sent in production traffic)", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }));

    await sendMetaCapiEvent(event, { ...credentials, testEventCode: undefined });

    const [, calledInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const sentBody = JSON.parse(calledInit.body as string);
    expect(sentBody.test_event_code).toBeUndefined();
    expect("test_event_code" in sentBody).toBe(false);
  });

  it("reports a non-2xx response as http_error with the response body redacted-and-captured", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid parameter", code: 100 } }), { status: 400 }),
    );

    const result = await sendMetaCapiEvent(event, credentials);
    expect(result.status).toBe("http_error");
    if (result.status !== "http_error") throw new Error("expected http_error");
    expect(result.httpStatus).toBe(400);
    expect(result.responseRedacted).toEqual({ error: { message: "Invalid parameter", code: 100 } });
  });

  it("reports a thrown fetch failure (network error) distinctly from an HTTP error", async () => {
    fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND graph.facebook.com"));

    const result = await sendMetaCapiEvent(event, credentials);
    expect(result.status).toBe("network_error");
    if (result.status !== "network_error") throw new Error("expected network_error");
    expect(result.error).toContain("ENOTFOUND");
  });

  it("never throws or logs the access token when the response body is not valid JSON", async () => {
    fetchMock.mockResolvedValue(new Response("not json", { status: 200 }));

    const result = await sendMetaCapiEvent(event, credentials);
    expect(result.status).toBe("sent");
    if (result.status !== "sent") throw new Error("expected sent");
    expect(result.responseRedacted).toBeNull();
  });

  it("redacts the access token from a network_error message even if the runtime's fetch error happened to embed the request URL (Phase 15 security review finding)", async () => {
    // Simulates a runtime whose fetch error message embeds the full failed
    // URL (some undici/fetch error causes do this) — the token must never
    // survive into `result.error`, since that value is persisted to
    // `dead_letters.failure_reason` (Postgres) and can reach logs.
    fetchMock.mockRejectedValue(
      new Error(`fetch failed: https://graph.facebook.com/v23.0/1234567890/events?access_token=${credentials.accessToken}`),
    );

    const result = await sendMetaCapiEvent(event, credentials);
    expect(result.status).toBe("network_error");
    if (result.status !== "network_error") throw new Error("expected network_error");
    expect(result.error).not.toContain(credentials.accessToken);
    expect(result.error).toContain("[REDACTED]");
  });
});
