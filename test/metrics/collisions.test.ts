import { describe, expect, it } from "vitest";
import { buildCollisionMatrix } from "../../src/metrics/collisions.js";
import type { PromptOutcome } from "../../src/metrics/types.js";

const outcomes = (invocations: readonly (readonly string[])[]): PromptOutcome[] => [
  {
    prompt: "p",
    expectation: "trigger",
    runs: invocations.map((invokedSkills) => ({ invokedSkills, usable: true, costUsd: 0 })),
  },
];

describe("buildCollisionMatrix", () => {
  it("puts each skill's own activation on the diagonal", () => {
    const matrix = buildCollisionMatrix([
      { skill: "alpha", outcomes: outcomes([["alpha"], ["alpha"], [], ["alpha"]]) },
      { skill: "beta", outcomes: outcomes([["beta"], ["beta"], ["beta"], ["beta"]]) },
    ]);

    expect(matrix.rateFor("alpha", "alpha")).toBeCloseTo(0.75);
    expect(matrix.rateFor("beta", "beta")).toBe(1);
  });

  it("records when another skill answers a prompt written for one skill", () => {
    const matrix = buildCollisionMatrix([
      { skill: "alpha", outcomes: outcomes([["beta"], ["alpha"], ["beta"], ["alpha"]]) },
      { skill: "beta", outcomes: outcomes([["beta"], ["beta"], ["beta"], ["beta"]]) },
    ]);

    expect(matrix.rateFor("alpha", "beta")).toBeCloseTo(0.5);
  });

  it("flags off-diagonal cells above the threshold as ambiguous descriptions", () => {
    const matrix = buildCollisionMatrix(
      [
        { skill: "alpha", outcomes: outcomes([["beta"], ["beta"], ["alpha"], ["alpha"]]) },
        { skill: "beta", outcomes: outcomes([["beta"], ["beta"], ["beta"], ["beta"]]) },
      ],
      { threshold: 0.25 },
    );

    expect(matrix.collisions).toEqual([
      { promptsFor: "alpha", answeredBy: "beta", rate: 0.5 },
    ]);
  });

  it("never reports a skill colliding with itself", () => {
    const matrix = buildCollisionMatrix(
      [{ skill: "alpha", outcomes: outcomes([["alpha"], ["alpha"]]) }],
      { threshold: 0.1 },
    );

    expect(matrix.collisions).toEqual([]);
  });

  it("ignores unusable runs when computing rates", () => {
    const matrix = buildCollisionMatrix([
      {
        skill: "alpha",
        outcomes: [
          {
            prompt: "p",
            expectation: "trigger",
            runs: [
              { invokedSkills: ["beta"], usable: true, costUsd: 0 },
              { invokedSkills: [], usable: false, costUsd: 0, unusableReason: "crashed" },
            ],
          },
        ],
      },
    ]);

    expect(matrix.rateFor("alpha", "beta")).toBe(1);
  });

  it("only scores prompts meant to trigger, since no-trigger prompts expect silence", () => {
    const matrix = buildCollisionMatrix([
      {
        skill: "alpha",
        outcomes: [
          { prompt: "yes", expectation: "trigger", runs: [{ invokedSkills: ["alpha"], usable: true, costUsd: 0 }] },
          { prompt: "no", expectation: "no-trigger", runs: [{ invokedSkills: ["beta"], usable: true, costUsd: 0 }] },
        ],
      },
    ]);

    expect(matrix.rateFor("alpha", "beta")).toBe(0);
    expect(matrix.rateFor("alpha", "alpha")).toBe(1);
  });

  it("lists every skill seen, including ones that only appear as intruders", () => {
    const matrix = buildCollisionMatrix([
      { skill: "alpha", outcomes: outcomes([["gamma"]]) },
    ]);

    expect(matrix.skills).toEqual(["alpha", "gamma"]);
  });
});
