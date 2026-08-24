import { describe, expect, it } from "vitest";
import { renderJson, renderMarkdown, renderTerminal } from "../../src/report/render.js";
import type { SkillReport } from "../../src/metrics/types.js";
import type { CollisionMatrix } from "../../src/metrics/collisions.js";

const passing: SkillReport = {
  skill: "alpha",
  prompts: [
    { prompt: "do alpha", expectation: "trigger", rate: 1, usableRuns: 5, totalRuns: 5, otherSkills: {} },
    { prompt: "unrelated", expectation: "no-trigger", rate: 0, usableRuns: 5, totalRuns: 5, otherSkills: {} },
  ],
  triggerRate: 1,
  noTriggerRate: 0,
  passed: true,
  failures: [],
  unusableRuns: 0,
  totalCostUsd: 0.12,
  contamination: [],
};

const failing: SkillReport = {
  ...passing,
  skill: "beta",
  triggerRate: 0.4,
  passed: false,
  failures: ["trigger rate 40% is below the gate of 90%"],
  prompts: [
    { prompt: "do beta", expectation: "trigger", rate: 0.4, usableRuns: 5, totalRuns: 5, otherSkills: { alpha: 3 } },
  ],
};

const matrix: CollisionMatrix = {
  skills: ["alpha", "beta"],
  collisions: [{ promptsFor: "beta", answeredBy: "alpha", rate: 0.6 }],
  rateFor: () => 0,
};

describe("renderTerminal", () => {
  it("shows each skill with its activation rate", () => {
    const output = renderTerminal([passing], undefined, { color: false });

    expect(output).toContain("alpha");
    expect(output).toContain("100%");
  });

  it("explains why a skill failed instead of only marking it failed", () => {
    const output = renderTerminal([failing], undefined, { color: false });

    expect(output).toContain("trigger rate 40% is below the gate of 90%");
  });

  it("names the skill that stole the prompts", () => {
    const output = renderTerminal([failing], matrix, { color: false });

    expect(output).toMatch(/beta.*alpha|alpha.*beta/s);
    expect(output).toContain("60%");
  });

  it("reports total cost so a run can be budgeted", () => {
    expect(renderTerminal([passing], undefined, { color: false })).toContain("0.12");
  });

  it("says plainly when everything passed", () => {
    expect(renderTerminal([passing], undefined, { color: false })).toMatch(/pass/i);
  });
});

describe("renderJson", () => {
  it("emits machine-readable results including the verdict", () => {
    const parsed = JSON.parse(renderJson([passing, failing], matrix)) as {
      passed: boolean;
      skills: { skill: string; passed: boolean }[];
      collisions: unknown[];
    };

    expect(parsed.passed).toBe(false);
    expect(parsed.skills.map((s) => s.skill)).toEqual(["alpha", "beta"]);
    expect(parsed.collisions).toHaveLength(1);
  });
});

describe("renderMarkdown", () => {
  it("produces a table suitable for a pull request comment", () => {
    const output = renderMarkdown([passing, failing], matrix);

    expect(output).toContain("| Skill |");
    expect(output).toContain("alpha");
    expect(output).toContain("beta");
    expect(output).toContain("Collisions");
  });
});
