import { describe, expect, it } from "vitest";
import { deriveChannel } from "./attribution.js";

describe("deriveChannel", () => {
  it("classifies a touch with fbclid as paid Meta, even without utm tags", () => {
    expect(deriveChannel({ fbclid: "abc123" })).toEqual({
      source: "meta",
      medium: "paid_social",
      isPaid: true,
    });
  });

  it("prefers explicit utm_source/utm_medium over the fbclid defaults when both are present", () => {
    expect(deriveChannel({ fbclid: "abc123", utm_source: "facebook", utm_medium: "cpc" })).toEqual({
      source: "facebook",
      medium: "cpc",
      isPaid: true,
    });
  });

  it("does NOT classify utm_source=meta as paid without an fbclid — no click id, no paid claim", () => {
    expect(deriveChannel({ utm_source: "meta", utm_medium: "social" })).toEqual({
      source: "meta",
      medium: "social",
      isPaid: false,
    });
  });

  it("classifies a touch with gclid as paid Google, even without utm tags", () => {
    expect(deriveChannel({ gclid: "xyz789" })).toEqual({
      source: "google",
      medium: "cpc",
      isPaid: true,
    });
  });

  it("prefers explicit utm_source/utm_medium over the gclid defaults when both are present", () => {
    expect(deriveChannel({ gclid: "xyz789", utm_source: "google_ads", utm_medium: "search" })).toEqual({
      source: "google_ads",
      medium: "search",
      isPaid: true,
    });
  });

  it("does NOT classify utm_source=google as paid without a gclid — no click id, no paid claim", () => {
    expect(deriveChannel({ utm_source: "google", utm_medium: "organic" })).toEqual({
      source: "google",
      medium: "organic",
      isPaid: false,
    });
  });

  it("prefers fbclid over gclid when (implausibly) both are present on the same touch", () => {
    expect(deriveChannel({ fbclid: "abc123", gclid: "xyz789" })).toEqual({
      source: "meta",
      medium: "paid_social",
      isPaid: true,
    });
  });

  it("falls back to referral when there is a referrer but no utm/fbclid", () => {
    expect(deriveChannel({ referrer: "https://google.com/search" })).toEqual({
      source: "referral",
      medium: "referral",
      isPaid: false,
    });
  });

  it("falls back to direct when there is no signal at all", () => {
    expect(deriveChannel({})).toEqual({ source: "direct", medium: "direct", isPaid: false });
  });
});
