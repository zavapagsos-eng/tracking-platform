import { describe, expect, it } from "vitest";
import { classifyMetaHttpError } from "./metaErrorClassification.js";

describe("classifyMetaHttpError", () => {
  it.each([
    [1, "retryable"],
    [2, "retryable"],
    [4, "retryable"],
    [17, "retryable"],
    [341, "retryable"],
    [368, "retryable"],
  ] as const)("treats documented transient code %d as %s", (code, expected) => {
    expect(classifyMetaHttpError({ error: { code, message: "x" } })).toBe(expected);
  });

  it.each([
    [3, "permanent"],
    [10, "permanent"],
    [102, "permanent"],
    [190, "permanent"],
    [250, "permanent"], // inside the documented 200-299 "API Permission" range
  ] as const)("treats documented permanent code %d as %s", (code, expected) => {
    expect(classifyMetaHttpError({ error: { code, message: "x" } })).toBe(expected);
  });

  it("defaults an unrecognized error code to retryable (conservative default)", () => {
    expect(classifyMetaHttpError({ error: { code: 999999, message: "unknown" } })).toBe("retryable");
  });

  it("defaults a response with no numeric error.code at all to retryable", () => {
    expect(classifyMetaHttpError({ error: { message: "no code field" } })).toBe("retryable");
    expect(classifyMetaHttpError({ notAnError: true })).toBe("retryable");
    expect(classifyMetaHttpError(null)).toBe("retryable");
    expect(classifyMetaHttpError(undefined)).toBe("retryable");
    expect(classifyMetaHttpError("not even an object")).toBe("retryable");
  });
});
