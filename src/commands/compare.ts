import { readFileSync } from "node:fs";
import type { Collision } from "../metrics/collisions.js";
import type { Expectation, SkillReport } from "../metrics/types.js";
import type { RunInfo } from "../report/render.js";

/** The parts of a `run --format json` report that a comparison reads. */
export interface ReportFile {
  readonly schemaVersion: 2;
  readonly run: RunInfo;
  readonly passed: boolean;
  readonly skills: readonly SkillReport[];
  readonly collisions: readonly Collision[];
}

export interface CaseChange {
  readonly id: string;
  readonly skill: string;
  readonly expectation: Expectation;
  readonly before: number | undefined;
  readonly after: number | undefined;
  readonly change: "added" | "removed" | "changed" | "same";
}

export interface Comparison {
  /** False when the two runs measured with a different agent or model, so rates cannot be compared. */
  readonly comparable: boolean;
  readonly differences: readonly string[];
  readonly notes: readonly string[];
  readonly regressions: readonly string[];
  readonly cases: readonly CaseChange[];
}

export function loadReport(path: string): ReportFile {
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ReportFile>;
  if (value.schemaVersion !== 2 || typeof value.run !== "object" || !Array.isArray(value.skills)) {
    throw new Error(`${path} is not a skillcaller report with schemaVersion 2; re-run with --format json`);
  }
  return { ...value, collisions: Array.isArray(value.collisions) ? value.collisions : [] } as ReportFile;
}

const percent = (rate: number | undefined) => (rate === undefined ? "unmeasured" : `${Math.round(rate * 100)}%`);

/** A regression is any measured case that got worse by more than maxDrop, or evidence that went missing. */
export function compareReports(base: ReportFile, candidate: ReportFile, options: { maxDrop: number }): Comparison {
  const differences: string[] = [];
  const notes: string[] = [];
  for (const field of ["agent", "model"] as const) {
    if (base.run[field] !== candidate.run[field]) {
      differences.push(`${field} differs: ${base.run[field] ?? "default"} vs ${candidate.run[field] ?? "default"}`);
    }
  }
  if (base.run.packDigest !== candidate.run.packDigest) notes.push("pack changed between the two runs");
  if (base.run.agentVersion !== candidate.run.agentVersion) {
    notes.push(`agent version differs: ${base.run.agentVersion ?? "unknown"} vs ${candidate.run.agentVersion ?? "unknown"}`);
  }
  if (base.run.skillcaller !== candidate.run.skillcaller) {
    notes.push(`skillcaller version differs: ${base.run.skillcaller} vs ${candidate.run.skillcaller}`);
  }
  const cached = candidate.skills.reduce((sum, skill) => sum + skill.cachedRuns, 0);
  if (cached > 0) {
    notes.push(`${cached} candidate runs came from the cache and may be the same observations as the baseline`);
  }

  const regressions: string[] = [];
  const cases = diffCases(base, candidate);
  const failingBefore = new Set(base.skills.filter((skill) => !skill.passed).map((skill) => skill.skill));
  for (const c of cases) {
    if (c.change === "removed" && failingBefore.has(c.skill)) {
      regressions.push(`${c.id} was removed while ${c.skill} was failing; confirm the removal is intended`);
    }
    if (c.change !== "changed") continue;
    if (c.before !== undefined && c.after === undefined) {
      regressions.push(`${c.id} is no longer measured (was ${percent(c.before)})`);
    } else if (c.before !== undefined && c.after !== undefined) {
      // For a trigger case lower is worse; for a no-trigger case higher is worse
      const worsened = c.expectation === "trigger" ? c.before - c.after : c.after - c.before;
      if (worsened > options.maxDrop + 1e-9) {
        regressions.push(`${c.id} (${c.expectation}) went from ${percent(c.before)} to ${percent(c.after)}`);
      }
    }
  }

  const passedBefore = new Set(base.skills.filter((skill) => skill.passed).map((skill) => skill.skill));
  for (const skill of candidate.skills) {
    if (!skill.passed && passedBefore.has(skill.skill)) regressions.push(`${skill.skill} passed before and fails now`);
  }
  const knownCollisions = new Set(base.collisions.map((c) => `${c.promptsFor}>${c.answeredBy}`));
  for (const c of candidate.collisions) {
    if (!knownCollisions.has(`${c.promptsFor}>${c.answeredBy}`)) {
      regressions.push(`new collision: prompts for ${c.promptsFor} answered by ${c.answeredBy} ${percent(c.rate)} of the time`);
    }
  }

  return { comparable: differences.length === 0, differences, notes, regressions, cases };
}

function diffCases(base: ReportFile, candidate: ReportFile): CaseChange[] {
  const index = (report: ReportFile) =>
    new Map(report.skills.flatMap((skill) => skill.prompts.map((p) => [p.id, { skill: skill.skill, ...p }] as const)));
  const before = index(base);
  const after = index(candidate);
  const changes: CaseChange[] = [];
  for (const [id, b] of before) {
    const a = after.get(id);
    changes.push({
      id,
      skill: b.skill,
      expectation: b.expectation,
      before: b.rate,
      after: a?.rate,
      change: a === undefined ? "removed" : a.rate === b.rate ? "same" : "changed",
    });
  }
  for (const [id, a] of after) {
    if (!before.has(id)) {
      changes.push({ id, skill: a.skill, expectation: a.expectation, before: undefined, after: a.rate, change: "added" });
    }
  }
  return changes;
}

export function renderComparison(comparison: Comparison, format: "terminal" | "markdown"): string {
  const md = format === "markdown";
  const heading = (text: string) => (md ? `### ${text}` : `${text}:`);
  const item = (text: string) => (md ? `- ${text}` : `  ${text}`);
  const lines = [md ? "## skillcaller compare" : "skillcaller compare", ""];
  const section = (title: string, items: readonly string[]) => {
    if (items.length > 0) lines.push(heading(title), ...items.map(item), "");
  };
  section("Not comparable", comparison.differences);
  section("Regressions", comparison.regressions);
  section("Notes", comparison.notes);
  section(
    "Changed cases",
    comparison.cases
      .filter((c) => c.change !== "same")
      .map((c) => `${c.id} (${c.expectation}): ${c.change}, ${percent(c.before)} -> ${percent(c.after)}`),
  );
  lines.push(
    !comparison.comparable
      ? "The reports cannot be compared."
      : comparison.regressions.length === 0
        ? "No regressions."
        : `${comparison.regressions.length} regression(s).`,
  );
  return lines.join("\n");
}
