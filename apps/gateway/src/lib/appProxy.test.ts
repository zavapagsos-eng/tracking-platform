import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyAppProxySignature, verifyAppProxySignatureAny } from "./appProxy.js";

const SECRET = "hush";

/** Builds a valid signature the same way Shopify's edge would, for tests. */
function sign(params: [string, string][]): URLSearchParams {
  const search = new URLSearchParams(params);
  const entries = new Map<string, string[]>();
  for (const [key, value] of search.entries()) {
    const existing = entries.get(key);
    if (existing) existing.push(value);
    else entries.set(key, [value]);
  }
  const canonical = [...entries.keys()]
    .sort()
    .map((key) => `${key}=${entries.get(key)!.join(",")}`)
    .join("");
  const signature = createHmac("sha256", SECRET).update(canonical).digest("hex");
  search.set("signature", signature);
  return search;
}

describe("verifyAppProxySignature", () => {
  it("accepts a correctly signed request, matching Shopify's documented example shape", () => {
    // Mirrors the worked example from shopify.dev "Authenticate app
    // proxies": extra=1,2 / logged_in_customer_id=1 / path_prefix / shop / timestamp.
    const params = sign([
      ["extra", "1"],
      ["extra", "2"],
      ["logged_in_customer_id", "1"],
      ["path_prefix", "/apps/awesome_reviews"],
      ["shop", "example.myshopify.com"],
      ["timestamp", "1317327555"],
    ]);

    expect(verifyAppProxySignature(params, SECRET)).toBe(true);
  });

  it("rejects when any parameter is tampered with after signing", () => {
    const params = sign([
      ["shop", "example.myshopify.com"],
      ["timestamp", "1317327555"],
    ]);
    params.set("shop", "attacker.myshopify.com");

    expect(verifyAppProxySignature(params, SECRET)).toBe(false);
  });

  it("rejects when signed with the wrong secret", () => {
    const params = sign([
      ["shop", "example.myshopify.com"],
      ["timestamp", "1317327555"],
    ]);

    expect(verifyAppProxySignature(params, "wrong-secret")).toBe(false);
  });

  it("rejects when the signature parameter is missing entirely", () => {
    const params = new URLSearchParams([["shop", "example.myshopify.com"]]);
    expect(verifyAppProxySignature(params, SECRET)).toBe(false);
  });

  it("rejects a non-hex signature instead of throwing", () => {
    const params = new URLSearchParams([
      ["shop", "example.myshopify.com"],
      ["signature", "not-hex!!"],
    ]);
    expect(verifyAppProxySignature(params, SECRET)).toBe(false);
  });
});

describe("verifyAppProxySignatureAny", () => {
  // Regression coverage for the production-readiness bug: this project
  // installs three DISTINCT Shopify apps (Store A/B/C, one per store,
  // since Shopify caps Web Pixel extensions at one per app), each with its
  // own client secret. A same-origin App Proxy call from any one store is
  // only ever signed with THAT store's app's secret — so verification must
  // try every configured app's secret, not assume a single shared one.
  const OTHER_SECRET = "store-b-secret";

  it("accepts when the request was signed by any one of several candidate secrets (not just the first)", () => {
    const params = sign([["shop", "store-b.myshopify.com"]]);
    // Re-sign with OTHER_SECRET to simulate a different app's request.
    const canonical = "shop=store-b.myshopify.com";
    params.set("signature", createHmac("sha256", OTHER_SECRET).update(canonical).digest("hex"));

    expect(verifyAppProxySignatureAny(params, [SECRET, OTHER_SECRET])).toBe(true);
    // Order shouldn't matter.
    expect(verifyAppProxySignatureAny(params, [OTHER_SECRET, SECRET])).toBe(true);
  });

  it("rejects when the request wasn't signed by any configured app's secret", () => {
    const params = sign([["shop", "attacker.myshopify.com"]]);
    expect(verifyAppProxySignatureAny(params, [OTHER_SECRET, "yet-another-secret"])).toBe(false);
  });

  it("returns false (never throws) against an empty candidate list", () => {
    const params = sign([["shop", "example.myshopify.com"]]);
    expect(verifyAppProxySignatureAny(params, [])).toBe(false);
  });
});
