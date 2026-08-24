import { describe, expect, it } from "vitest";
import { scoreSkill } from "../../src/metrics/score.js";
import type { Corpus } from "../../src/corpus/schema.js";
import type { PromptOutcome } from "../../src/metrics/types.js";

const corpus: Corpus = {
  skill: "target",
  runs: 4,
  gates: { trigger: 0.9, noTrigger: 0.05 },
  shouldTrigger: ["a", "b"],
  shouldNotTrigger: ["x"],
};

const outcome = (
  prompt: string,
  expectation: "trigger" | "no-trigger",
  invocations: readonly (readonly string[])[],
): PromptOutcome => ({
  prompt,
  expectation,
  runs: invocations.map((invokedSkills) => ({ invokedSkills, usable: true, costUsd: 0.01 })),
});

describe("scoreSkill", () => {
  it("computes the activation rate as invocations over usable runs", () => {
    const report = scoreSkill(corpus, [
      outcome("a", "trigger", [["target"], ["target"], [], ["target"]]),
      outcome("b", "trigger", [["target"], ["target"], ["target"], ["target"]]),
      outcome("x", "no-trigger", [[], [], [], []]),
    ]);

    expect(report.prompts[0]?.rate).toBeCloseTo(0.75);
    expect(report.prompts[1]?.rate).toBe(1);
    expect(report.triggerRate).toBeCloseTo(0.875);
    expect(report.noTriggerRate).toBe(0);
  });

  it("fails the gate when the trigger rate is below threshold", () => {
    const report = scoreSkill(corpus, [
      outcome("a", "trigger", [["target"], [], [], []]),
      outcome("b", "trigger", [["target"], ["target"], ["target"], ["target"]]),
      outcome("x", "no-trigger", [[], [], [], []]),
    ]);

    expect(report.passed).toBe(false);
    expect(report.failures.join(" ")).toMatch(/trigger rate/i);
  });

  it("uses the worst prompt, not the average, for false triggers", () => {
    // Averaging would hide a single prompt that fires the skill every time.
    const report = scoreSkill(corpus, [
      outcome("a", "trigger", [["target"], ["target"], ["target"], ["target"]]),
      outcome("b", "trigger", [["target"], ["target"], ["target"], ["target"]]),
      outcome("x", "no-trigger", [["target"], ["target"], ["target"], ["target"]]),
    ]);

    expect(report.noTriggerRate).toBe(1);
    expect(report.passed).toBe(false);
    expect(report.failures.join(" ")).toMatch(/should_not_trigger/i);
  });

  it("counts a run as a hit only for the skill under test", () => {
    const report = scoreSkill(corpus, [
      outcome("a", "trigger", [["someone-else"], ["someone-else"], ["someone-else"], ["someone-else"]]),
      outcome("b", "trigger", [["target"], ["target"], ["target"], ["target"]]),
      outcome("x", "no-trigger", [[], [], [], []]),
    ]);

    expect(report.prompts[0]?.rate).toBe(0);
  });

  it("records which other skills answered, so collisions surface", () => {
    const report = scoreSkill(corpus, [
      outcome("a", "trigger", [["rival"], ["target"], ["rival"], ["target"]]),
      outcome("b", "trigger", [["target"], ["target"], ["target"], ["target"]]),
      outcome("x", "no-trigger", [[], [], [], []]),
    ]);

    expect(report.prompts[0]?.otherSkills).toEqual({ rival: 2 });
  });

  it("excludes unusable runs from the rate rather than scoring them as misses", () => {
    const report = scoreSkill(corpus, [
      {
        prompt: "a",
        expectation: "trigger",
        runs: [
          { invokedSkills: ["target"], usable: true, costUsd: 0 },
          { invokedSkills: [], usable: false, costUsd: 0, unusableReason: "not logged in" },
        ],
      },
      outcome("b", "trigger", [["target"]]),
      outcome("x", "no-trigger", [[]]),
    ]);

    expect(report.prompts[0]?.rate).toBe(1);
    expect(report.prompts[0]?.usableRuns).toBe(1);
    expect(report.unusableRuns).toBe(1);
  });

  it("fails loudly when a prompt has no usable runs at all", () => {
    // A rate of 0/0 must never be reported as pass or fail by accident.
    const report = scoreSkill(corpus, [
      {
        prompt: "a",
        expectation: "trigger",
        runs: [{ invokedSkills: [], usable: false, costUsd: 0, unusableReason: "crashed" }],
      },
      outcome("b", "trigger", [["target"]]),
      outcome("x", "no-trigger", [[]]),
    ]);

    expect(report.prompts[0]?.rate).toBeUndefined();
    expect(report.passed).toBe(false);
    expect(report.failures.join(" ")).toMatch(/no usable runs/i);
  });

  it("totals the cost of every run, usable or not", () => {
    const report = scoreSkill(corpus, [
      outcome("a", "trigger", [["target"], ["target"]]),
      outcome("b", "trigger", [["target"]]),
      outcome("x", "no-trigger", [[]]),
    ]);

    expect(report.totalCostUsd).toBeCloseTo(0.04);
  });
});

describe("scoreSkill contamination", () => {
  it("fails a skill whose runs reached outside the pack", () => {
    // The parsers found foreign skills but never reported them
    const report = scoreSkill(corpus, [
      {
        prompt: "a",
        expectation: "trigger",
        runs: [{ invokedSkills: ["target"], foreignSkills: ["someones-personal-skill"], usable: true, costUsd: 0 }],
      },
      outcome("b", "trigger", [["target"]]),
      outcome("x", "no-trigger", [[]]),
    ]);

    expect(report.contamination).toEqual(["someones-personal-skill"]);
    expect(report.passed).toBe(false);
    expect(report.failures.join(" ")).toMatch(/contaminated/i);
  });

  it("reports a clean run as uncontaminated", () => {
    const report = scoreSkill(corpus, [
      outcome("a", "trigger", [["target"]]),
      outcome("b", "trigger", [["target"]]),
      outcome("x", "no-trigger", [[]]),
    ]);

    expect(report.contamination).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
