import { describe, expect, it } from "vitest";
import {
  computeAllAttributionModels,
  computeFirstTouch,
  computeLastNonDirectTouch,
  computeLastPaidTouch,
  computeLastTouch,
} from "./attributionModels.js";
import type { AttributionTouchRow } from "./journey.js";

let touchCounter = 0;

/** Builds a minimal touch row — only the fields the models actually read
 * are meaningful per-test, the rest are filled with harmless defaults. */
function touch(partial: Partial<AttributionTouchRow> & { occurredAt: Date }): AttributionTouchRow {
  touchCounter += 1;
  return {
    touchId: `touch-${touchCounter}`,
    trackingId: "tracking-1",
    sessionId: "session-1",
    source: "direct",
    medium: "direct",
    campaign: null,
    campaignId: null,
    adsetId: null,
    adId: null,
    fbclid: null,
    fbc: null,
    fbp: null,
    gclid: null,
    landingPage: null,
    referrer: null,
    isPaid: false,
    ...partial,
  };
}

const day = (n: number) => new Date(Date.UTC(2026, 0, n));

describe("attribution models — spec worked example (Meta day1 -> Direct day3 -> Meta day5 -> Purchase day5)", () => {
  const metaDay1 = touch({ occurredAt: day(1), source: "meta", medium: "paid_social", isPaid: true, campaign: "day1" });
  const directDay3 = touch({ occurredAt: day(3), source: "direct", medium: "direct" });
  const metaDay5 = touch({ occurredAt: day(5), source: "meta", medium: "paid_social", isPaid: true, campaign: "day5" });
  const touches = [metaDay1, directDay3, metaDay5];

  it("FIRST_TOUCH is the day-1 Meta touch", () => {
    expect(computeFirstTouch(touches)).toBe(metaDay1);
  });

  it("LAST_TOUCH is the day-5 Meta touch", () => {
    expect(computeLastTouch(touches)).toBe(metaDay5);
  });

  it("LAST_NON_DIRECT is the day-5 Meta touch (last touch already isn't direct)", () => {
    expect(computeLastNonDirectTouch(touches)).toBe(metaDay5);
  });

  it("LAST_PAID_TOUCH is the day-5 Meta touch", () => {
    expect(computeLastPaidTouch(touches)).toBe(metaDay5);
  });

  it("computeAllAttributionModels returns all four consistently", () => {
    expect(computeAllAttributionModels(touches)).toEqual({
      FIRST_TOUCH: metaDay1,
      LAST_TOUCH: metaDay5,
      LAST_NON_DIRECT: metaDay5,
      LAST_PAID_TOUCH: metaDay5,
    });
  });
});

describe("attribution models — a direct touch after the last paid/non-direct one", () => {
  const metaDay1 = touch({ occurredAt: day(1), source: "meta", isPaid: true });
  const directDay5 = touch({ occurredAt: day(5), source: "direct" });
  const touches = [metaDay1, directDay5];

  it("LAST_TOUCH is the trailing direct touch", () => {
    expect(computeLastTouch(touches)).toBe(directDay5);
  });

  it("LAST_NON_DIRECT skips the trailing direct touch and finds the Meta one", () => {
    expect(computeLastNonDirectTouch(touches)).toBe(metaDay1);
  });

  it("LAST_PAID_TOUCH skips the trailing direct touch and finds the Meta one", () => {
    expect(computeLastPaidTouch(touches)).toBe(metaDay1);
  });
});

describe("attribution models — an all-direct journey", () => {
  const touches = [touch({ occurredAt: day(1) }), touch({ occurredAt: day(2) })];

  it("LAST_NON_DIRECT is null — never fabricates a non-direct channel that isn't there", () => {
    expect(computeLastNonDirectTouch(touches)).toBeNull();
  });

  it("LAST_PAID_TOUCH is null — never fabricates a paid touch that isn't there", () => {
    expect(computeLastPaidTouch(touches)).toBeNull();
  });
});

describe("attribution models — an empty journey", () => {
  it("every model is null, never a fabricated placeholder touch", () => {
    expect(computeAllAttributionModels([])).toEqual({
      FIRST_TOUCH: null,
      LAST_TOUCH: null,
      LAST_NON_DIRECT: null,
      LAST_PAID_TOUCH: null,
    });
  });
});

describe("attribution models — utm_source without fbclid is never treated as paid", () => {
  it("LAST_PAID_TOUCH is null for a journey with only an unpaid 'meta' utm_source touch", () => {
    // isPaid: false here mirrors what lib/attribution.ts `deriveChannel`
    // actually produces for utm_source=meta with no fbclid — this test
    // guards the model logic itself, independent of that classification.
    const touches = [touch({ occurredAt: day(1), source: "meta", medium: "social", isPaid: false })];
    expect(computeLastPaidTouch(touches)).toBeNull();
  });
});
