import { caseId, type Corpus } from "../corpus/schema.js";
import type { Expectation } from "../metrics/types.js";
import type { Pack } from "../pack/load-pack.js";

export interface PlannedCase {
  readonly id: string;
  readonly expectation: Expectation;
  readonly prompt: string;
}

export interface PlannedSkill {
  readonly skill: string;
  readonly runs: number;
  /** Null when the agent's own default applies. */
  readonly timeoutMs: number | null;
  readonly cases: readonly PlannedCase[];
}

export interface Plan {
  readonly root: string;
  readonly agent: string;
  readonly model: string | null;
  readonly concurrency: number;
  readonly calls: number;
  /** Present when the cache is on: calls a run would answer from it. */
  readonly cachedCalls?: number;
  readonly unmeasured: readonly string[];
  readonly skills: readonly PlannedSkill[];
}

export interface PlanOptions {
  readonly agent: string;
  readonly concurrency: number;
  readonly model?: string;
  readonly timeoutMs?: number;
}

export function casesOf(corpus: Corpus): PlannedCase[] {
  return [
    ...corpus.shouldTrigger.map((prompt) => ({ expectation: "trigger" as const, prompt })),
    ...corpus.shouldNotTrigger.map((prompt) => ({ expectation: "no-trigger" as const, prompt })),
  ].map((c) => ({ id: caseId(corpus.skill, c.expectation, c.prompt), ...c }));
}

/** What `run` would do with the same options. Pure: no agent, no cache, no staging. */
export function planPack(pack: Pack, options: PlanOptions): Plan {
  const skills = pack.entries.map((entry) => ({
    skill: entry.corpus.skill,
    runs: entry.corpus.runs,
    timeoutMs: options.timeoutMs ?? entry.corpus.timeoutMs ?? null,
    cases: casesOf(entry.corpus),
  }));
  return {
    root: pack.root,
    agent: options.agent,
    model: options.model ?? null,
    concurrency: options.concurrency,
    calls: skills.reduce((sum, skill) => sum + skill.cases.length * skill.runs, 0),
    unmeasured: pack.skillsWithoutCorpus,
    skills,
  };
}

export function renderPlan(plan: Plan): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const lines = [`Pack: ${plan.root}`, `Agent: ${plan.agent}, model ${plan.model ?? "agent default"}`, ""];
  for (const skill of plan.skills) {
    const timeout = skill.timeoutMs === null ? "agent default timeout" : `timeout ${skill.timeoutMs}ms`;
    lines.push(`${skill.skill}: ${plural(skill.cases.length, "prompt")} x ${plural(skill.runs, "run")}, ${timeout}`);
    for (const c of skill.cases) lines.push(`  ${c.id}  ${c.expectation.padEnd(10)}  ${c.prompt}`);
  }
  if (plan.unmeasured.length > 0) lines.push("", `Not measured (no corpus): ${plan.unmeasured.join(", ")}`);
  lines.push(
    "",
    `${plural(plan.calls, "agent call")} at concurrency ${plan.concurrency}` +
      (plan.cachedCalls === undefined ? "" : `; ${plan.cachedCalls} answered from the cache`),
  );
  return lines.join("\n");
}
