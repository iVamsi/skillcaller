import pc from "picocolors";
import type { CollisionMatrix } from "../metrics/collisions.js";
import type { SkillReport } from "../metrics/types.js";

/** Identifies one evaluation, so a report can be traced back to what produced it. */
export interface RunInfo {
  readonly skillcaller: string;
  readonly agent: string;
  /** Null when the agent CLI could not report one. */
  readonly agentVersion: string | null;
  /** Null when the agent picks its own default. */
  readonly model: string | null;
  readonly packDigest: string;
}

export const REPORT_SCHEMA_VERSION = 2;

export interface RenderOptions {
  readonly color?: boolean;
  readonly skippedSkills?: readonly string[];
}

const percent = (rate: number | undefined): string =>
  rate === undefined ? "n/a" : `${(rate * 100).toFixed(0)}%`;

const money = (usd: number): string => `$${usd.toFixed(2)}`;

export function renderTerminal(
  reports: readonly SkillReport[],
  matrix?: CollisionMatrix,
  options: RenderOptions = {},
): string {
  const color = options.color !== false;
  const green = (s: string) => (color ? pc.green(s) : s);
  const red = (s: string) => (color ? pc.red(s) : s);
  const dim = (s: string) => (color ? pc.dim(s) : s);

  const lines: string[] = [];
  const width = Math.max(5, ...reports.map((report) => report.skill.length));

  for (const report of reports) {
    const mark = report.passed ? green("PASS") : red("FAIL");
    lines.push(
      `${mark}  ${report.skill.padEnd(width)}  triggers ${percent(report.triggerRate)}  ` +
        `false triggers ${percent(report.noTriggerRate)}`,
    );
    for (const failure of report.failures) {
      lines.push(`      ${red("-")} ${failure}`);
    }
    if (report.unusableRuns > 0) {
      lines.push(dim(`      ${report.unusableRuns} run(s) could not be scored:`));
      for (const [reason, count] of Object.entries(report.unusableReasons)) {
        lines.push(dim(`        ${reason} (${count})`));
      }
    }
    if (report.contamination.length > 0) {
      lines.push(`      ${red("!")} reached skills outside the pack: ${report.contamination.join(", ")}`);
    }
  }

  if (matrix !== undefined && matrix.collisions.length > 0) {
    lines.push("");
    lines.push("Collisions (another skill answered these prompts):");
    for (const collision of matrix.collisions) {
      lines.push(
        `  ${collision.promptsFor} -> answered by ${collision.answeredBy} ${percent(collision.rate)} of the time`,
      );
    }
  }

  const skipped = options.skippedSkills ?? [];
  if (skipped.length > 0) {
    lines.push(dim(`Not measured (no corpus): ${skipped.join(", ")}`));
  }

  const totalCost = reports.reduce((sum, report) => sum + report.totalCostUsd, 0);
  const unpriced = reports.reduce((sum, report) => sum + report.unpricedRuns, 0);
  const cost = dim(`  cost ${money(totalCost)}${unpriced > 0 ? ` (${unpriced} run(s) reported no cost)` : ""}`);
  const failed = reports.filter((report) => !report.passed).length;
  const collisions = matrix?.collisions.length ?? 0;
  lines.push("");
  if (reports.length === 0) {
    lines.push(red("No skills were measured."));
  } else if (failed === 0 && collisions === 0) {
    lines.push(green(`All ${reports.length} skill(s) passed.`) + cost);
  } else {
    const parts = [
      ...(failed > 0 ? [`${failed} of ${reports.length} skill(s) failed`] : []),
      ...(collisions > 0 ? [`${collisions} collision(s) found`] : []),
    ];
    lines.push(red(`${parts.join(", ")}.`) + cost);
  }

  return lines.join("\n");
}

/** True when every measured skill passed and there are no collisions. An empty run is not a pass. */
export function runPassed(reports: readonly SkillReport[], matrix?: CollisionMatrix): boolean {
  return reports.length > 0 && reports.every((report) => report.passed) && (matrix?.collisions.length ?? 0) === 0;
}

export function renderJson(
  reports: readonly SkillReport[],
  matrix?: CollisionMatrix,
  skippedSkills: readonly string[] = [],
  run?: RunInfo,
): string {
  // Fields from schema 1 keep their names and meaning; schema 2 only adds
  return JSON.stringify(
    {
      schemaVersion: REPORT_SCHEMA_VERSION,
      ...(run === undefined ? {} : { run }),
      passed: runPassed(reports, matrix),
      skills: reports,
      skippedSkills,
      collisions: matrix?.collisions ?? [],
      totalCostUsd: reports.reduce((sum, report) => sum + report.totalCostUsd, 0),
    },
    null,
    2,
  );
}

export function renderMarkdown(
  reports: readonly SkillReport[],
  matrix?: CollisionMatrix,
  skippedSkills: readonly string[] = [],
): string {
  const lines: string[] = [
    "## skillcaller",
    "",
    "| Skill | Triggers | False triggers | Result |",
    "| --- | --- | --- | --- |",
  ];

  if (reports.length === 0) {
    lines.push("", "No skills were measured.");
  }

  for (const report of reports) {
    lines.push(
      `| ${report.skill} | ${percent(report.triggerRate)} | ${percent(report.noTriggerRate)} | ${report.passed ? "pass" : "fail"} |`,
    );
  }

  const contaminated = reports.filter((report) => report.contamination.length > 0);
  if (contaminated.length > 0) {
    lines.push("", "### Contamination", "");
    for (const report of contaminated) {
      lines.push(`- **${report.skill}** reached skills outside the pack: ${report.contamination.join(", ")}`);
    }
  }

  const failures = reports.filter((report) => report.failures.length > 0);
  if (failures.length > 0) {
    lines.push("", "### Failures", "");
    for (const report of failures) {
      for (const failure of report.failures) lines.push(`- **${report.skill}**: ${failure}`);
    }
  }

  if (skippedSkills.length > 0) {
    lines.push("", "### Not measured", "");
    for (const skill of skippedSkills) lines.push(`- **${skill}**: missing corpus`);
  }

  if (matrix !== undefined && matrix.collisions.length > 0) {
    lines.push("", "### Collisions", "");
    for (const collision of matrix.collisions) {
      lines.push(
        `- prompts for **${collision.promptsFor}** were answered by **${collision.answeredBy}** ${percent(collision.rate)} of the time`,
      );
    }
  }

  return lines.join("\n");
}

/** JUnit XML, so CI systems show each skill as a test case. */
export function renderJUnit(
  reports: readonly SkillReport[],
  matrix?: CollisionMatrix,
  skippedSkills: readonly string[] = [],
): string {
  const escape = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  if (reports.length === 0) {
    const message =
      skippedSkills.length === 0
        ? "no skills were measured"
        : `no skills were measured; missing corpus: ${skippedSkills.join(", ")}`;
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<testsuites>\n` +
      `  <testsuite name="skillcaller" tests="1" failures="1">\n` +
      `    <testcase classname="skillcaller" name="measured skills">\n` +
      `      <failure message="${escape(message)}" />\n` +
      `    </testcase>\n` +
      `  </testsuite>\n` +
      `</testsuites>\n`
    );
  }

  const collisions = matrix?.collisions ?? [];
  const failures = reports.filter((report) => !report.passed).length + (collisions.length > 0 ? 1 : 0);
  const cases = reports
    .map((report) => {
      const name = escape(report.skill);
      if (report.passed) return `    <testcase classname="skillcaller" name="${name}" />`;
      const message = escape(report.failures.join("; "));
      return (
        `    <testcase classname="skillcaller" name="${name}">\n` +
        `      <failure message="${message}" />\n` +
        `    </testcase>`
      );
    })
    .join("\n");

  const collisionCase =
    collisions.length === 0
      ? ""
      : `\n    <testcase classname="skillcaller" name="collisions">\n` +
        `      <failure message="${escape(
          collisions
            .map((c) => `prompts for ${c.promptsFor} answered by ${c.answeredBy} ${(c.rate * 100).toFixed(0)}% of the time`)
            .join("; "),
        )}" />\n` +
        `    </testcase>`;

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites>\n` +
    `  <testsuite name="skillcaller" tests="${reports.length + (collisions.length > 0 ? 1 : 0)}" failures="${failures}">\n` +
    `${cases}${collisionCase}\n` +
    `  </testsuite>\n` +
    `</testsuites>\n`
  );
}
