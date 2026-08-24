import type { Corpus } from "../corpus/schema.js";
import type { PromptOutcome, PromptReport, SkillReport } from "./types.js";

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function scorePrompt(skill: string, outcome: PromptOutcome): PromptReport {
  const usable = outcome.runs.filter((run) => run.usable);
  const hits = usable.filter((run) => run.invokedSkills.includes(skill)).length;

  const otherSkills: Record<string, number> = {};
  for (const run of usable) {
    for (const invoked of run.invokedSkills) {
      if (invoked === skill) continue;
      otherSkills[invoked] = (otherSkills[invoked] ?? 0) + 1;
    }
  }

  return {
    prompt: outcome.prompt,
    expectation: outcome.expectation,
    rate: usable.length === 0 ? undefined : hits / usable.length,
    usableRuns: usable.length,
    totalRuns: outcome.runs.length,
    otherSkills,
  };
}

/** Mean trigger rate, worst false-trigger rate. Unmeasured prompts fail. */
export function scoreSkill(corpus: Corpus, outcomes: readonly PromptOutcome[]): SkillReport {
  const prompts = outcomes.map((outcome) => scorePrompt(corpus.skill, outcome));

  const triggerRates = prompts
    .filter((report) => report.expectation === "trigger")
    .map((report) => report.rate);
  const noTriggerRates = prompts
    .filter((report) => report.expectation === "no-trigger")
    .map((report) => report.rate);

  const measuredTrigger = triggerRates.filter((rate): rate is number => rate !== undefined);
  const measuredNoTrigger = noTriggerRates.filter((rate): rate is number => rate !== undefined);

  const triggerRate =
    measuredTrigger.length === 0
      ? undefined
      : measuredTrigger.reduce((sum, rate) => sum + rate, 0) / measuredTrigger.length;
  const noTriggerRate = measuredNoTrigger.length === 0 ? undefined : Math.max(...measuredNoTrigger);

  const failures: string[] = [];

  const unmeasured = prompts.filter((report) => report.rate === undefined);
  for (const report of unmeasured) {
    failures.push(`"${report.prompt}" had no usable runs, so it was never measured`);
  }

  if (triggerRate !== undefined && triggerRate < corpus.gates.trigger) {
    failures.push(
      `trigger rate ${percent(triggerRate)} is below the gate of ${percent(corpus.gates.trigger)}`,
    );
  }
  if (noTriggerRate !== undefined && noTriggerRate > corpus.gates.noTrigger) {
    const worst = prompts
      .filter((report) => report.expectation === "no-trigger" && report.rate === noTriggerRate)
      .map((report) => `"${report.prompt}"`)
      .join(", ");
    failures.push(
      `should_not_trigger rate ${percent(noTriggerRate)} exceeds the gate of ${percent(corpus.gates.noTrigger)} (worst: ${worst})`,
    );
  }

  const allRuns = outcomes.flatMap((outcome) => outcome.runs);

  const contamination = [...new Set(allRuns.flatMap((run) => run.foreignSkills ?? []))].sort();
  if (contamination.length > 0) {
    failures.push(
      `measured in a contaminated environment: the agent reached skills outside the pack ` +
        `(${contamination.join(", ")})`,
    );
  }

  return {
    skill: corpus.skill,
    prompts,
    triggerRate,
    noTriggerRate,
    passed: failures.length === 0,
    failures,
    unusableRuns: allRuns.filter((run) => !run.usable).length,
    totalCostUsd: allRuns.reduce((sum, run) => sum + run.costUsd, 0),
    contamination,
  };
}
