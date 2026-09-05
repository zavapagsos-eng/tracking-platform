import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeMetaUserData } from "./metaNormalization.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("normalizeMetaUserData — hashed fields", () => {
  it("lowercases and trims email before hashing", () => {
    const result = normalizeMetaUserData({ email: "  Shopper@Example.com  " });
    expect(result.em).toBe(sha256("shopper@example.com"));
  });

  it("strips all non-digit characters from phone before hashing", () => {
    const result = normalizeMetaUserData({ phone: "+1 (555) 123-4567" });
    expect(result.ph).toBe(sha256("15551234567"));
  });

  it("lowercases first/last name, strips punctuation, but keeps internal spaces", () => {
    const result = normalizeMetaUserData({ firstName: "Mary-Jane", lastName: "van der Berg" });
    expect(result.fn).toBe(sha256("maryjane"));
    expect(result.ln).toBe(sha256("van der berg"));
  });

  it("strips punctuation AND spaces from city (unlike name fields)", () => {
    const result = normalizeMetaUserData({ city: "São Paulo" });
    expect(result.ct).toBe(sha256("são paulo".replace(/[^\p{L}\p{N}]/gu, "")));
  });

  it("lowercases the state/province code as-is", () => {
    const result = normalizeMetaUserData({ stateCode: "SP" });
    expect(result.st).toBe(sha256("sp"));
  });

  it("truncates a US zip to 5 digits but keeps other countries' zips whole", () => {
    const us = normalizeMetaUserData({ zip: "94103-1234", countryCode: "US" });
    expect(us.zp).toBe(sha256("94103"));

    const nonUs = normalizeMetaUserData({ zip: "SW1A 1AA", countryCode: "GB" });
    expect(nonUs.zp).toBe(sha256("sw1a1aa"));
  });

  it("lowercases the country code", () => {
    const result = normalizeMetaUserData({ countryCode: "BR" });
    expect(result.country).toBe(sha256("br"));
  });

  it("hashes external_id but preserves case (no lowercasing rule documented for it)", () => {
    const result = normalizeMetaUserData({ externalId: "TrackingId-ABC123" });
    expect(result.external_id).toBe(sha256("TrackingId-ABC123"));
  });
});

describe("normalizeMetaUserData — never fabricates a value for an absent/empty field", () => {
  it("omits a field entirely when not provided", () => {
    const result = normalizeMetaUserData({ email: "a@b.com" });
    expect(result.ph).toBeUndefined();
    expect(result.fn).toBeUndefined();
  });

  it("omits a field that normalizes to an empty string rather than hashing an empty string", () => {
    const result = normalizeMetaUserData({ firstName: "   ", city: "!!!" });
    expect(result.fn).toBeUndefined();
    expect(result.ct).toBeUndefined();
    // Guard against a regression that would hash "" — a fixed, well-known
    // value that must never appear in this output.
    expect(Object.values(result)).not.toContain(sha256(""));
  });
});

describe("normalizeMetaUserData — passthrough (never hashed) fields", () => {
  it("passes client_ip_address, client_user_agent, fbc, fbp through unhashed and trimmed", () => {
    const result = normalizeMetaUserData({
      clientIpAddress: "  203.0.113.7  ",
      clientUserAgent: "Mozilla/5.0",
      fbc: "fb.1.111.click1",
      fbp: "fb.1.222.random",
    });
    expect(result.client_ip_address).toBe("203.0.113.7");
    expect(result.client_user_agent).toBe("Mozilla/5.0");
    expect(result.fbc).toBe("fb.1.111.click1");
    expect(result.fbp).toBe("fb.1.222.random");
  });

  it("omits a passthrough field that is empty/whitespace-only", () => {
    const result = normalizeMetaUserData({ clientIpAddress: "   " });
    expect(result.client_ip_address).toBeUndefined();
  });
});

describe("normalizeMetaUserData — Event Match Quality maximization", () => {
  it("includes every legitimately available field at once, omitting only what's actually missing", () => {
    const result = normalizeMetaUserData({
      email: "shopper@example.com",
      phone: "+15551234567",
      firstName: "Ana",
      lastName: "Silva",
      city: "Sao Paulo",
      stateCode: "SP",
      zip: "01310-100",
      countryCode: "BR",
      fbc: "fb.1.1.click1",
      fbp: "fb.1.1.p1",
      clientIpAddress: "203.0.113.7",
      clientUserAgent: "Mozilla/5.0",
    });

    expect(Object.keys(result).sort()).toEqual(
      ["em", "ph", "fn", "ln", "ct", "st", "zp", "country", "fbc", "fbp", "client_ip_address", "client_user_agent"].sort(),
    );
  });
});
