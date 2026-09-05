import { describe, expect, it, vi } from "vitest";
import type { BrowserCookie } from "@shopify/web-pixels-extension";
import {
  generateUuidV4,
  getOrCreateSessionId,
  getOrCreateTrackingId,
  refreshSessionId,
  TRACKING_ID_COOKIE,
  SESSION_ID_COOKIE,
} from "./identity.js";

function fakeCookieJar(initial: Record<string, string> = {}): BrowserCookie {
  const store = { ...initial };
  return {
    get: vi.fn(async (name?: string) => (name ? (store[name] ?? "") : "")),
    set: vi.fn(async (cookieOrName: string, value?: string) => {
      if (value !== undefined) {
        store[cookieOrName] = value;
      } else {
        const [pair] = cookieOrName.split(";");
        const [key, val] = pair!.split("=");
        store[key!.trim()] = val ?? "";
      }
      return cookieOrName;
    }),
  };
}

describe("generateUuidV4", () => {
  it("produces a well-formed v4 UUID using the native crypto.randomUUID", () => {
    const id = generateUuidV4();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("falls back to crypto.getRandomValues when randomUUID is unavailable", () => {
    const fakeCrypto = {
      getRandomValues: (arr: Uint8Array) => {
        arr.fill(0xab);
        return arr;
      },
    } as unknown as Crypto;
    const id = generateUuidV4(fakeCrypto);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

describe("getOrCreateTrackingId", () => {
  it("creates and persists a new id when no cookie exists", async () => {
    const cookie = fakeCookieJar();
    const result = await getOrCreateTrackingId(cookie);
    expect(result.isNew).toBe(true);
    expect(cookie.set).toHaveBeenCalledWith(expect.stringContaining(`${TRACKING_ID_COOKIE}=`));
  });

  it("reuses the existing id without regenerating it", async () => {
    const cookie = fakeCookieJar({ [TRACKING_ID_COOKIE]: "existing-tracking-id" });
    const result = await getOrCreateTrackingId(cookie);
    expect(result).toEqual({ id: "existing-tracking-id", isNew: false });
    expect(cookie.set).not.toHaveBeenCalled();
  });
});

describe("getOrCreateSessionId / refreshSessionId", () => {
  it("creates a new session id distinct from the tracking id cookie", async () => {
    const cookie = fakeCookieJar({ [TRACKING_ID_COOKIE]: "tid-1" });
    const result = await getOrCreateSessionId(cookie);
    expect(result.isNew).toBe(true);
    expect(cookie.set).toHaveBeenCalledWith(expect.stringContaining(`${SESSION_ID_COOKIE}=`));
  });

  it("refreshSessionId re-sets the same value to slide the inactivity window", async () => {
    const cookie = fakeCookieJar();
    await refreshSessionId(cookie, "sid-123");
    expect(cookie.set).toHaveBeenCalledWith(expect.stringContaining(`${SESSION_ID_COOKIE}=sid-123`));
  });
});
