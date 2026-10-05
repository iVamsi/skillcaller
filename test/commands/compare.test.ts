import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareReports, loadReport, type ReportFile } from "../../src/commands/compare.js";
import type { PromptReport, SkillReport } from "../../src/metrics/types.js";

const prompt = (id: string, expectation: "trigger" | "no-trigger", rate: number | undefined): PromptReport => ({
  id,
  prompt: `prompt ${id}`,
  expectation,
  rate,
  usableRuns: 5,
  totalRuns: 5,
  otherSkills: {},
});

const skill = (passed: boolean, prompts: PromptReport[], cachedRuns = 0): SkillReport => ({
  skill: "alpha",
  prompts,
  triggerRate: 1,
  noTriggerRate: 0,
  passed,
  failures: passed ? [] : ["failed"],
  unusableRuns: 0,
  unusableReasons: {},
  unusableCodes: {},
  expectedRuns: prompts.length * 5,
  completedRuns: prompts.length * 5,
  cachedRuns,
  unpricedRuns: 0,
  totalCostUsd: 0,
  contamination: [],
});

function report(skills: readonly SkillReport[], overrides: Partial<ReportFile> = {}): ReportFile {
  return {
    schemaVersion: 2,
    run: { skillcaller: "0.1.1", agent: "claude-code", agentVersion: "2.0.0", model: "haiku", packDigest: "aaa" },
    passed: skills.every((s) => s.passed),
    skills,
    collisions: [],
    ...overrides,
  };
}

const base = report([skill(true, [prompt("a/1", "trigger", 1), prompt("a/2", "no-trigger", 0)])]);

describe("compareReports", () => {
  it("finds no regression between identical reports", () => {
    const result = compareReports(base, base, { maxDrop: 0.1 });

    expect(result.comparable).toBe(true);
    expect(result.regressions).toEqual([]);
  });

  it("flags a trigger rate that dropped more than the allowed amount", () => {
    const candidate = report([skill(true, [prompt("a/1", "trigger", 0.8), prompt("a/2", "no-trigger", 0)])]);

    expect(compareReports(base, candidate, { maxDrop: 0.1 }).regressions.join()).toMatch(/a\/1.*100%.*80%/);
    expect(compareReports(base, candidate, { maxDrop: 0.2 }).regressions).toEqual([]);
  });

  it("flags a false-trigger rate that rose", () => {
    const candidate = report([skill(true, [prompt("a/1", "trigger", 1), prompt("a/2", "no-trigger", 0.4)])]);

    expect(compareReports(base, candidate, { maxDrop: 0.1 }).regressions.join()).toMatch(/a\/2/);
  });

  it("flags a prompt that was measured before and is not now", () => {
    const candidate = report([skill(false, [prompt("a/1", "trigger", undefined), prompt("a/2", "no-trigger", 0)])]);

    expect(compareReports(base, candidate, { maxDrop: 0.1 }).regressions.join()).toMatch(/a\/1.*no longer measured/);
  });

  it("refuses to call reports from different models comparable", () => {
    const candidate = report(base.skills, { run: { ...base.run, model: "opus" } });

    const result = compareReports(base, candidate, { maxDrop: 0.1 });
    expect(result.comparable).toBe(false);
    expect(result.differences.join()).toMatch(/model/);
  });

  it("notes a changed pack and agent version without blocking the comparison", () => {
    const candidate = report(base.skills, { run: { ...base.run, packDigest: "bbb", agentVersion: "2.1.0" } });

    const result = compareReports(base, candidate, { maxDrop: 0.1 });
    expect(result.comparable).toBe(true);
    expect(result.notes.join()).toMatch(/pack changed/);
    expect(result.notes.join()).toMatch(/agent version/);
  });

  it("flags a new collision", () => {
    const candidate = report(base.skills, { collisions: [{ promptsFor: "alpha", answeredBy: "beta", rate: 0.4 }] });

    expect(compareReports(base, candidate, { maxDrop: 0.1 }).regressions.join()).toMatch(/alpha.*beta/);
  });

  it("does not let removing a failing skill's prompt look like an improvement", () => {
    const failing = report([skill(false, [prompt("a/1", "trigger", 0.2), prompt("a/2", "no-trigger", 0)])]);
    const candidate = report([skill(true, [prompt("a/2", "no-trigger", 0)])]);

    const result = compareReports(failing, candidate, { maxDrop: 0.1 });
    expect(result.regressions.join()).toMatch(/a\/1.*removed/);
  });

  it("lists added prompts", () => {
    const candidate = report([skill(true, [...(base.skills[0]?.prompts ?? []), prompt("a/3", "trigger", 1)])]);

    expect(compareReports(base, candidate, { maxDrop: 0.1 }).cases.filter((c) => c.change === "added")).toHaveLength(1);
  });

  it("warns when the candidate replayed cached samples", () => {
    const candidate = report([skill(true, base.skills[0]?.prompts as PromptReport[], 10)]);

    expect(compareReports(base, candidate, { maxDrop: 0.1 }).notes.join()).toMatch(/10 candidate runs came from the cache/);
  });
});

describe("loadReport", () => {
  it("rejects a report without the schema 2 envelope", () => {
    const file = join(mkdtempSync(join(tmpdir(), "skillcaller-compare-")), "old.json");
    writeFileSync(file, JSON.stringify({ passed: true, skills: [] }));

    expect(() => loadReport(file)).toThrow(/schemaVersion 2/);
  });
});
