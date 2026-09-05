import { describe, expect, it, vi } from "vitest";
import type { BrowserCookie } from "@shopify/web-pixels-extension";
import { captureAttribution, deriveFbcFromClickId } from "./attribution.js";

function fakeCookieJar(initial: Record<string, string> = {}): BrowserCookie {
  const store = { ...initial };
  return {
    get: vi.fn(async (name?: string) => (name ? (store[name] ?? "") : "")),
    set: vi.fn(async (cookieOrName: string) => {
      const [pair] = cookieOrName.split(";");
      const [key, val] = pair!.split("=");
      store[key!.trim()] = val ?? "";
      return cookieOrName;
    }),
  };
}

describe("deriveFbcFromClickId", () => {
  it("matches Meta's documented _fbc format fb.{subdomainIndex}.{creationTimeMs}.{fbclid}", () => {
    expect(deriveFbcFromClickId("abc123", 1700000000000, 1)).toBe("fb.1.1700000000000.abc123");
  });
});

describe("captureAttribution", () => {
  it("captures fbclid and UTMs present in the URL, and nothing that isn't", async () => {
    const cookie = fakeCookieJar();
    const result = await captureAttribution(
      cookie,
      "https://store-a.example.com/products/x?fbclid=abc123&utm_source=meta&utm_campaign=summer",
      "",
    );
    expect(result.fbclid).toBe("abc123");
    expect(result.utm_source).toBe("meta");
    expect(result.utm_campaign).toBe("summer");
    expect(result.utm_medium).toBeUndefined(); // never fabricated
  });

  it("prefers a real _fbc cookie over deriving one from fbclid", async () => {
    const cookie = fakeCookieJar({ _fbc: "fb.1.111.real-cookie-value" });
    const result = await captureAttribution(
      cookie,
      "https://store-a.example.com/?fbclid=should-not-be-used-to-derive",
      "",
    );
    expect(result.fbc).toBe("fb.1.111.real-cookie-value");
  });

  it("derives and persists _fbc from fbclid when no real cookie exists yet", async () => {
    const cookie = fakeCookieJar();
    const now = () => 1700000000000;
    const result = await captureAttribution(
      cookie,
      "https://store-a.example.com/?fbclid=xyz789",
      "",
      now,
    );
    expect(result.fbc).toBe("fb.1.1700000000000.xyz789");
    expect(cookie.set).toHaveBeenCalledWith(expect.stringContaining("_fbc=fb.1.1700000000000.xyz789"));
  });

  it("captures gclid present in the URL, independently of fbclid", async () => {
    const cookie = fakeCookieJar();
    const result = await captureAttribution(
      cookie,
      "https://store-a.example.com/products/x?gclid=xyz789&utm_source=google&utm_campaign=summer",
      "",
    );
    expect(result.gclid).toBe("xyz789");
    expect(result.utm_source).toBe("google");
    expect(result.fbclid).toBeUndefined();
  });

  it("omits gclid when absent from the URL — never fabricated", async () => {
    const cookie = fakeCookieJar();
    const result = await captureAttribution(cookie, "https://store-a.example.com/", "");
    expect(result.gclid).toBeUndefined();
  });

  it("never fabricates fbp when the cookie is absent", async () => {
    const cookie = fakeCookieJar();
    const result = await captureAttribution(cookie, "https://store-a.example.com/", "");
    expect(result.fbp).toBeUndefined();
  });

  it("captures referrer and landing_page when present, omits them when not", async () => {
    const cookie = fakeCookieJar();
    const withReferrer = await captureAttribution(
      cookie,
      "https://store-a.example.com/",
      "https://google.com/search",
    );
    expect(withReferrer.referrer).toBe("https://google.com/search");
    expect(withReferrer.landing_page).toBe("https://store-a.example.com/");

    const withoutReferrer = await captureAttribution(cookie, "https://store-a.example.com/", "");
    expect(withoutReferrer.referrer).toBeUndefined();
  });

  it("returns an empty result for a malformed location without throwing", async () => {
    const cookie = fakeCookieJar();
    const result = await captureAttribution(cookie, "not-a-valid-url", "");
    expect(result).toEqual({});
  });
});
