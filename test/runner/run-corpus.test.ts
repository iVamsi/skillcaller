import { describe, expect, it } from "vitest";
import { runCorpus } from "../../src/runner/run-corpus.js";
import type { AgentAdapter, RunRequest } from "../../src/adapters/types.js";
import type { Corpus } from "../../src/corpus/schema.js";
import type { RunOutcome } from "../../src/metrics/types.js";

const corpus: Corpus = {
  skill: "target",
  runs: 3,
  gates: { trigger: 0.9, noTrigger: 0.05 },
  shouldTrigger: ["a", "b"],
  shouldNotTrigger: ["x"],
};

function adapterOf(
  handler: (request: RunRequest) => Promise<RunOutcome> | RunOutcome,
  id = "fake",
): AgentAdapter {
  return { id, runPrompt: async (request) => handler(request) };
}

const hit: RunOutcome = { invokedSkills: ["target"], usable: true, costUsd: 0.01 };

describe("runCorpus", () => {
  it("runs every prompt the configured number of times", async () => {
    const calls: string[] = [];
    const outcomes = await runCorpus(corpus, adapterOf((request) => {
      calls.push(request.prompt);
      return hit;
    }), { packDir: "/pack" });

    expect(calls).toHaveLength(9); // 3 prompts x 3 runs
    expect(outcomes.map((outcome) => outcome.prompt)).toEqual(["a", "b", "x"]);
    expect(outcomes[0]?.runs).toHaveLength(3);
  });

  it("labels each prompt with the expectation it came from", async () => {
    const outcomes = await runCorpus(corpus, adapterOf(() => hit), { packDir: "/pack" });

    expect(outcomes.map((outcome) => outcome.expectation)).toEqual(["trigger", "trigger", "no-trigger"]);
  });

  it("keeps prompt order even when runs finish out of order", async () => {
    const outcomes = await runCorpus(
      corpus,
      adapterOf(async (request) => {
        // "a" resolves last; results must still come back in corpus order.
        await new Promise((resolve) => setTimeout(resolve, request.prompt === "a" ? 20 : 1));
        return hit;
      }),
      { packDir: "/pack", concurrency: 4 },
    );

    expect(outcomes.map((outcome) => outcome.prompt)).toEqual(["a", "b", "x"]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await runCorpus(
      corpus,
      adapterOf(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return hit;
      }),
      { packDir: "/pack", concurrency: 2 },
    );

    expect(peak).toBeLessThanOrEqual(2);
  });

  it("records an adapter crash as an unusable run instead of aborting the suite", async () => {
    let call = 0;
    const outcomes = await runCorpus(
      corpus,
      adapterOf(() => {
        call += 1;
        if (call === 1) throw new Error("cli exploded");
        return hit;
      }),
      { packDir: "/pack", concurrency: 1 },
    );

    const failed = outcomes.flatMap((outcome) => outcome.runs).filter((run) => !run.usable);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.unusableReason).toMatch(/cli exploded/);
    expect(outcomes.flatMap((outcome) => outcome.runs)).toHaveLength(9);
  });

  it("passes the pack directory and model through to the adapter", async () => {
    const seen: RunRequest[] = [];
    await runCorpus(corpus, adapterOf((request) => { seen.push(request); return hit; }), {
      packDir: "/packs/mine",
      model: "claude-haiku-4-5-20251001",
    });

    expect(seen[0]?.packDir).toBe("/packs/mine");
    expect(seen[0]?.model).toBe("claude-haiku-4-5-20251001");
  });

  it("reports progress as runs complete", async () => {
    const seen: number[] = [];
    await runCorpus(corpus, adapterOf(() => hit), {
      packDir: "/pack",
      onProgress: (completed, total) => {
        seen.push(completed);
        expect(total).toBe(9);
      },
    });

    expect(seen).toHaveLength(9);
    expect(seen.at(-1)).toBe(9);
  });
});
