import { describe, expect, it } from "vitest";
import { renderJUnit } from "../../src/report/render.js";
import type { SkillReport } from "../../src/metrics/types.js";

const report = (skill: string, passed: boolean, failures: string[] = []): SkillReport => ({
  skill,
  prompts: [],
  triggerRate: passed ? 1 : 0.4,
  noTriggerRate: 0,
  passed,
  failures,
  unusableRuns: 0,
  totalCostUsd: 0,
  contamination: [],
});

describe("renderJUnit", () => {
  it("emits one test case per skill with a suite-level failure count", () => {
    const xml = renderJUnit([report("alpha", true), report("beta", false, ["trigger rate 40%"])]);

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('tests="2"');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('name="alpha" />');
    expect(xml).toContain('<failure message="trigger rate 40%" />');
  });

  it("escapes characters that would break the XML", () => {
    // Skill names and failure text can contain quotes and angle brackets
    const xml = renderJUnit([report('a<b&c"d', false, ['says "no" & <stops>'])]);

    expect(xml).toContain("a&lt;b&amp;c&quot;d");
    expect(xml).toContain("says &quot;no&quot; &amp; &lt;stops&gt;");
    expect(xml).not.toMatch(/name="a<b/);
  });

  it("joins multiple failures into one message", () => {
    const xml = renderJUnit([report("beta", false, ["first problem", "second problem"])]);

    expect(xml).toContain("first problem; second problem");
  });
});
