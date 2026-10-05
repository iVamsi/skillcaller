import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diagnose } from "../../src/commands/doctor.js";

/** A stand-in CLI that prints a version and a help text listing the given flags. */
function stubCli(flags: readonly string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "skillcaller-doctor-")), "cli");
  writeFileSync(
    path,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("9.9.9"); process.exit(0); }
console.log(${JSON.stringify(flags.join("\n"))});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("diagnose", () => {
  it("passes when the CLI runs and lists every flag skillcaller passes", async () => {
    const report = await diagnose("codex", stubCli(["--json", "--sandbox", "--skip-git-repo-check", "--model"]));

    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual(expect.objectContaining({ name: "version", status: "ok", detail: "9.9.9" }));
  });

  it("fails once, clearly, when the CLI is not installed", async () => {
    const report = await diagnose("codex", join(tmpdir(), "skillcaller-missing-cli"));

    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ name: "version", status: "fail" });
    expect(report.checks.some((check) => check.name === "flags")).toBe(false);
  });

  it("warns about a flag missing from --help without failing", async () => {
    const report = await diagnose("codex", stubCli(["--json"]));

    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "flags", status: "warn", detail: expect.stringContaining("--sandbox") }),
    );
  });

  it("says what each probe executes", async () => {
    const report = await diagnose("codex", stubCli([]));

    expect(report.probes).toEqual([expect.stringMatching(/--version$/), expect.stringMatching(/exec --help$/)]);
  });

  it("lists the agent's capabilities and where each claim comes from", async () => {
    const report = await diagnose("claude-code", stubCli([]));

    expect(report.capabilities.map((c) => c.name)).toEqual(
      expect.arrayContaining(["activation signal", "your own skills", "cost reporting"]),
    );
    expect(report.capabilities.every((c) => c.evidence.length > 0)).toBe(true);
  });
});
