import pc from "picocolors";
import type { CollisionMatrix } from "../metrics/collisions.js";
import type { SkillReport } from "../metrics/types.js";

export interface RenderOptions {
  readonly color?: boolean;
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
      lines.push(dim(`      ${report.unusableRuns} run(s) could not be scored`));
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

  const totalCost = reports.reduce((sum, report) => sum + report.totalCostUsd, 0);
  const failed = reports.filter((report) => !report.passed).length;
  const collisions = matrix?.collisions.length ?? 0;
  lines.push("");
  if (failed === 0 && collisions === 0) {
    lines.push(green(`All ${reports.length} skill(s) passed.`) + dim(`  cost ${money(totalCost)}`));
  } else {
    const parts = [
      ...(failed > 0 ? [`${failed} of ${reports.length} skill(s) failed`] : []),
      ...(collisions > 0 ? [`${collisions} collision(s) found`] : []),
    ];
    lines.push(red(`${parts.join(", ")}.`) + dim(`  cost ${money(totalCost)}`));
  }

  return lines.join("\n");
}

/** True when every skill passed and there are no collisions. */
export function runPassed(reports: readonly SkillReport[], matrix?: CollisionMatrix): boolean {
  return reports.every((report) => report.passed) && (matrix?.collisions.length ?? 0) === 0;
}

export function renderJson(reports: readonly SkillReport[], matrix?: CollisionMatrix): string {
  return JSON.stringify(
    {
      passed: runPassed(reports, matrix),
      skills: reports,
      collisions: matrix?.collisions ?? [],
      totalCostUsd: reports.reduce((sum, report) => sum + report.totalCostUsd, 0),
    },
    null,
    2,
  );
}

export function renderMarkdown(reports: readonly SkillReport[], matrix?: CollisionMatrix): string {
  const lines: string[] = [
    "## skillcaller",
    "",
    "| Skill | Triggers | False triggers | Result |",
    "| --- | --- | --- | --- |",
  ];

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
export function renderJUnit(reports: readonly SkillReport[], matrix?: CollisionMatrix): string {
  const escape = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
