import { describe, expect, it } from "vitest";
import { findStoreByShopId, loadConfig } from "./config.js";

const HMAC_SECRET = "test-secret-at-least-32-characters-long!!";

function envWithStores(storesJson: string | undefined): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://localhost/test",
    GATEWAY_HMAC_SECRET: HMAC_SECRET,
    ...(storesJson !== undefined ? { SHOPIFY_STORES: storesJson } : {}),
  } as unknown as NodeJS.ProcessEnv;
}

/**
 * `SHOPIFY_STORES` validation (`parseStoresJson`, config.ts) is otherwise
 * only ever exercised via other test files' VALID fixture registries
 * (server.test.ts, webhooks.test.ts) — its actual failure paths (the
 * reason this parsing exists as a dedicated Zod refinement in the first
 * place, per docs/PHASE_LOG.md's "Correção de Arquitetura — Multi-Loja de
 * Destino") had no direct coverage anywhere. These tests close that gap.
 */
describe("loadConfig — SHOPIFY_STORES validation", () => {
  it("defaults to an empty registry when SHOPIFY_STORES is unset", () => {
    const config = loadConfig(envWithStores(undefined));
    expect(config.SHOPIFY_STORES).toEqual([]);
  });

  it("rejects malformed JSON with a clear message", () => {
    expect(() => loadConfig(envWithStores("{not valid json"))).toThrowError(/SHOPIFY_STORES must be valid JSON/);
  });

  it("rejects a JSON value that isn't an array of valid store entries", () => {
    expect(() => loadConfig(envWithStores(JSON.stringify({ shop_id: "store-a" })))).toThrowError(/SHOPIFY_STORES/);
  });

  it("rejects a store entry missing a required field", () => {
    expect(() =>
      loadConfig(envWithStores(JSON.stringify([{ shop_id: "store-a", domain: "store-a.example.com", role: "storefront" }]))),
    ).toThrowError(/SHOPIFY_STORES/);
  });

  it("rejects a store entry with an invalid role", () => {
    expect(() =>
      loadConfig(
        envWithStores(
          JSON.stringify([{ shop_id: "store-a", domain: "store-a.example.com", role: "warehouse", webhook_secret: "s" }]),
        ),
      ),
    ).toThrowError(/SHOPIFY_STORES/);
  });

  it("rejects two store entries claiming the same shop_id", () => {
    const duplicated = JSON.stringify([
      { shop_id: "store-a", domain: "a1.example.com", role: "storefront", webhook_secret: "s1" },
      { shop_id: "store-a", domain: "a2.example.com", role: "checkout", webhook_secret: "s2" },
    ]);
    expect(() => loadConfig(envWithStores(duplicated))).toThrowError(/duplicate shop_id "store-a"/);
  });

  it("accepts a valid registry with distinct shop_ids", () => {
    const valid = JSON.stringify([
      { shop_id: "hub", domain: "hub.example.com", role: "storefront", webhook_secret: "s1" },
      { shop_id: "loja-b", domain: "loja-b.example.com", role: "checkout", webhook_secret: "s2" },
    ]);
    const config = loadConfig(envWithStores(valid));
    expect(config.SHOPIFY_STORES).toHaveLength(2);
  });
});

describe("findStoreByShopId", () => {
  it("returns the matching store entry", () => {
    const config = loadConfig(
      envWithStores(
        JSON.stringify([{ shop_id: "loja-b", domain: "loja-b.example.com", role: "checkout", webhook_secret: "s2" }]),
      ),
    );
    expect(findStoreByShopId(config, "loja-b")?.domain).toBe("loja-b.example.com");
  });

  it("returns undefined for a shop_id not in the registry — never guesses", () => {
    const config = loadConfig(envWithStores(JSON.stringify([])));
    expect(findStoreByShopId(config, "unknown-store")).toBeUndefined();
  });
});
