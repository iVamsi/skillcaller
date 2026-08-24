import type { PromptOutcome } from "./types.js";

export interface CorpusOutcomes {
  readonly skill: string;
  readonly outcomes: readonly PromptOutcome[];
}

export interface Collision {
  readonly promptsFor: string;
  readonly answeredBy: string;
  readonly rate: number;
}

export interface CollisionMatrix {
  readonly skills: readonly string[];
  readonly collisions: readonly Collision[];
  rateFor(promptsFor: string, answeredBy: string): number;
}

export interface CollisionOptions {
  readonly threshold?: number;
}

const DEFAULT_THRESHOLD = 0.2;

export function buildCollisionMatrix(
  corpora: readonly CorpusOutcomes[],
  options: CollisionOptions = {},
): CollisionMatrix {
  const counts = new Map<string, Map<string, number>>();
  const usableRuns = new Map<string, number>();
  const skills: string[] = [];

  const see = (skill: string): void => {
    if (!skills.includes(skill)) skills.push(skill);
  };

  for (const { skill, outcomes } of corpora) {
    see(skill);
    const row = counts.get(skill) ?? new Map<string, number>();
    counts.set(skill, row);

    let usable = 0;
    for (const outcome of outcomes) {
      if (outcome.expectation !== "trigger") continue;
      for (const run of outcome.runs) {
        if (!run.usable) continue;
        usable += 1;
        for (const invoked of run.invokedSkills) {
          see(invoked);
          row.set(invoked, (row.get(invoked) ?? 0) + 1);
        }
      }
    }
    usableRuns.set(skill, usable);
  }

  const rateFor = (promptsFor: string, answeredBy: string): number => {
    const runs = usableRuns.get(promptsFor) ?? 0;
    if (runs === 0) return 0;
    return (counts.get(promptsFor)?.get(answeredBy) ?? 0) / runs;
  };

  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const collisions: Collision[] = [];
  for (const promptsFor of skills) {
    for (const answeredBy of skills) {
      if (promptsFor === answeredBy) continue;
      const rate = rateFor(promptsFor, answeredBy);
      if (rate >= threshold) collisions.push({ promptsFor, answeredBy, rate });
    }
  }

  return { skills, collisions, rateFor };
}
