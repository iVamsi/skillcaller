import { describe, expect, it } from "vitest";
import { positiveInt, rate } from "../../src/cli-options.js";

describe("positiveInt", () => {
  it("parses a number", () => {
    expect(positiveInt("4", 2, "--concurrency")).toBe(4);
  });

  it("falls back and explains when the value is not a number", () => {
    // NaN concurrency started zero workers; every prompt then reported "no usable runs"
    const warnings: string[] = [];
    expect(positiveInt("abc", 2, "--concurrency", (message) => warnings.push(message))).toBe(2);
    expect(warnings[0]).toMatch(/--concurrency/);
  });

  it("rejects a partly numeric value rather than truncating it", () => {
    expect(positiveInt("2abc", 2, "--concurrency", () => undefined)).toBe(2);
    expect(positiveInt("4", 2, "--concurrency")).toBe(4);
  });

  it("rejects zero and negatives, which would start no workers", () => {
    expect(positiveInt("0", 2, "--concurrency")).toBe(2);
    expect(positiveInt("-3", 2, "--concurrency")).toBe(2);
  });
});

describe("rate", () => {
  it("parses a fraction", () => {
    expect(rate("0.35", 0.2, "--collision-threshold")).toBeCloseTo(0.35);
  });

  it("falls back when the value is not a number", () => {
    // A NaN threshold compares false against every rate, silently disabling collision reporting.
    expect(rate("high", 0.2, "--collision-threshold")).toBe(0.2);
  });

  it("rejects values outside 0..1", () => {
    expect(rate("1.5", 0.2, "--collision-threshold")).toBe(0.2);
    expect(rate("-0.1", 0.2, "--collision-threshold")).toBe(0.2);
  });
});
