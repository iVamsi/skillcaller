import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/program.js";
import { loadPack } from "../../src/pack/load-pack.js";

let stdout: string;
let stderr: string;

beforeEach(() => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr += String(chunk); return true; });
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

const run = (args: string[]) => createProgram().parseAsync(["node", "skillcaller", ...args]);

function skillDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "skillcaller-cli-"));
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: Use when doing ${name}\n---\n\nbody\n`);
  return dir;
}

function pack(script: Record<string, string[][]>): { packDir: string; scriptFile: string } {
  const packDir = skillDir("alpha");
  mkdirSync(join(packDir, "alpha", "evals"), { recursive: true });
  writeFileSync(
    join(packDir, "alpha", "evals", "triggers.yaml"),
    `skill: alpha\nruns: 1\nshould_trigger: ["do alpha"]\nshould_not_trigger: ["do nothing"]\n`,
  );
  const scriptFile = join(packDir, "script.json");
  writeFileSync(scriptFile, JSON.stringify(script));
  return { packDir, scriptFile };
}

describe("skillcaller init", () => {
  it("scaffolds a corpus the loader accepts", async () => {
    const dir = skillDir("my-skill");

    await run(["init", join(dir, "my-skill")]);

    expect(() => loadPack(dir)).not.toThrow();
    const corpus = loadPack(dir).entries[0]?.corpus;
    expect(corpus?.shouldTrigger.length).toBeGreaterThan(0);
  });

  it("scaffolds a corpus that can be run immediately", async () => {
    const dir = skillDir("my-skill");
    await run(["init", join(dir, "my-skill")]);

    await run(["run", dir, "--agent", "fake", "--no-cache"]);

    expect(stderr).not.toMatch(/Too small|expected string/);
  });

  it("fails gracefully with a clean message when evals/triggers.yaml already exists", async () => {
    const dir = skillDir("my-skill");
    await run(["init", join(dir, "my-skill")]);
    expect(process.exitCode).toBe(0);

    await run(["init", join(dir, "my-skill")]);
    expect(stderr).toMatch(/already exists/);
    expect(process.exitCode).toBe(1);
  });
});

describe("skillcaller run", () => {
  it("reports a passing pack as passed with exit code 0", async () => {
    const { packDir, scriptFile } = pack({ "do alpha": [["alpha"]], "do nothing": [[]] });

    await run(["run", packDir, "--agent", "fake", "--script", scriptFile, "--no-cache"]);

    expect(stdout).toMatch(/passed/i);
    expect(process.exitCode).toBe(0);
  });

  it("agrees with itself when only a collision fails the run", async () => {
    const { packDir, scriptFile } = pack({ "do alpha": [["alpha", "intruder"]], "do nothing": [[]] });

    await run(["run", packDir, "--agent", "fake", "--script", scriptFile, "--format", "json", "--no-cache"]);

    const report = JSON.parse(stdout) as { passed: boolean; collisions: unknown[] };
    expect(report.collisions.length).toBeGreaterThan(0);
    expect(report.passed).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("counts a collision as a JUnit failure", async () => {
    const { packDir, scriptFile } = pack({ "do alpha": [["alpha", "intruder"]], "do nothing": [[]] });

    await run(["run", packDir, "--agent", "fake", "--script", scriptFile, "--format", "junit", "--no-cache"]);

    expect(stdout).not.toContain('failures="0"');
    expect(stdout).toMatch(/collision/i);
  });

  it("does not claim every skill passed when a collision was found", async () => {
    const { packDir, scriptFile } = pack({ "do alpha": [["alpha", "intruder"]], "do nothing": [[]] });

    await run(["run", packDir, "--agent", "fake", "--script", scriptFile, "--no-cache"]);

    expect(stdout).not.toMatch(/All 1 skill\(s\) passed/);
  });

  it("rejects an unknown output format instead of silently printing terminal output", async () => {
    const { packDir, scriptFile } = pack({ "do alpha": [["alpha"]], "do nothing": [[]] });

    await run(["run", packDir, "--agent", "fake", "--script", scriptFile, "--format", "yaml", "--no-cache"]);

    expect(stderr).toMatch(/--format/);
    expect(process.exitCode).toBe(1);
  });

  it("rejects a partly numeric concurrency instead of silently truncating it", async () => {
    // parseInt("2abc") === 2
    const { packDir, scriptFile } = pack({ "do alpha": [["alpha"]], "do nothing": [[]] });

    await run(["run", packDir, "--agent", "fake", "--script", scriptFile, "--concurrency", "2abc", "--no-cache"]);

    expect(stderr).toMatch(/--concurrency/);
  });

  it("auto-discovers skills directory in current working directory when omitted", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "skillcaller-autodiscover-"));
    const skillsDir = join(cwd, "skills", "alpha");
    mkdirSync(join(skillsDir, "evals"), { recursive: true });
    writeFileSync(join(skillsDir, "SKILL.md"), "---\nname: alpha\ndescription: d\n---\n");
    writeFileSync(
      join(skillsDir, "evals", "triggers.yaml"),
      `skill: alpha\nruns: 1\nshould_trigger: ["do alpha"]\nshould_not_trigger: ["do nothing"]\n`,
    );
    const scriptFile = join(cwd, "script.json");
    writeFileSync(scriptFile, JSON.stringify({ "do alpha": [["alpha"]], "do nothing": [[]] }));

    const origCwd = process.cwd();
    try {
      process.chdir(cwd);
      await run(["run", "--agent", "fake", "--script", scriptFile, "--no-cache"]);
      expect(stdout).toMatch(/passed/i);
      expect(process.exitCode).toBe(0);
    } finally {
      process.chdir(origCwd);
    }
  });

  it("reports a clear error when no pack path is given and no standard directory exists", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "skillcaller-empty-"));
    const origCwd = process.cwd();
    try {
      process.chdir(cwd);
      await run(["run", "--agent", "fake", "--no-cache"]);
      expect(stderr).toMatch(/no skill pack path provided/);
      expect(process.exitCode).toBe(1);
    } finally {
      process.chdir(origCwd);
    }
  });

  it("prints the planned agent-call count before running", async () => {
    const { packDir, scriptFile } = pack({ "do alpha": [["alpha"]], "do nothing": [[]] });

    await run(["run", packDir, "--agent", "fake", "--script", scriptFile, "--no-cache"]);

    expect(stderr).toMatch(/2 agent calls across 1 skill/);
    expect(stderr).toMatch(/concurrency 2/);
  });

  it("passes custom --timeout through to the run", async () => {
    const { packDir, scriptFile } = pack({ "do alpha": [["alpha"]], "do nothing": [[]] });

    await run(["run", packDir, "--agent", "fake", "--script", scriptFile, "--timeout", "5000", "--no-cache"]);

    expect(stdout).toMatch(/passed/i);
    expect(process.exitCode).toBe(0);
  });

  it("warns on invalid --timeout and falls back", async () => {
    const { packDir, scriptFile } = pack({ "do alpha": [["alpha"]], "do nothing": [[]] });

    await run(["run", packDir, "--agent", "fake", "--script", scriptFile, "--timeout", "invalid", "--no-cache"]);

    expect(stderr).toMatch(/--timeout/);
    expect(stdout).toMatch(/passed/i);
    expect(process.exitCode).toBe(0);
  });

  it("logs non-TTY progress when running in terminal mode", async () => {
    const { packDir, scriptFile } = pack({ "do alpha": [["alpha"]], "do nothing": [[]] });
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });

    try {
      await run(["run", packDir, "--agent", "fake", "--script", scriptFile, "--no-cache"]);
      expect(stderr).toContain("alpha: evaluated");
    } finally {
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
    }
  });

  it("evaluates multiple skills across a pack with global concurrency", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skillcaller-multi-"));
    mkdirSync(join(dir, "alpha", "evals"), { recursive: true });
    writeFileSync(join(dir, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: alpha\n---\n");
    writeFileSync(join(dir, "alpha", "evals", "triggers.yaml"), `skill: alpha\nruns: 1\nshould_trigger: ["do alpha"]\n`);

    mkdirSync(join(dir, "beta", "evals"), { recursive: true });
    writeFileSync(join(dir, "beta", "SKILL.md"), "---\nname: beta\ndescription: beta\n---\n");
    writeFileSync(join(dir, "beta", "evals", "triggers.yaml"), `skill: beta\nruns: 1\nshould_trigger: ["do beta"]\n`);

    const scriptFile = join(dir, "script.json");
    writeFileSync(scriptFile, JSON.stringify({ "do alpha": [["alpha"]], "do beta": [["beta"]] }));

    await run(["run", dir, "--agent", "fake", "--script", scriptFile, "--concurrency", "4", "--no-cache"]);

    expect(stdout).toMatch(/All 2 skill\(s\) passed/);
    expect(process.exitCode).toBe(0);
  });

  it("fails every report format when no skill has a corpus", async () => {
    const dir = skillDir("alpha");

    for (const format of ["terminal", "json", "markdown", "junit"]) {
      stdout = "";
      stderr = "";
      process.exitCode = 0;
      await run(["run", dir, "--agent", "fake", "--format", format, "--no-cache"]);

      expect(process.exitCode, format).toBe(1);
      if (format === "json") {
        const report = JSON.parse(stdout) as { passed: boolean; skills: unknown[]; skippedSkills: string[] };
        expect(report.passed).toBe(false);
        expect(report.skills).toEqual([]);
        expect(report.skippedSkills).toEqual(["alpha"]);
      } else {
        expect(stdout).toMatch(/no skills were measured/i);
      }
    }
  });

  it("names skills that were skipped because they have no corpus", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skillcaller-partial-"));
    mkdirSync(join(dir, "alpha", "evals"), { recursive: true });
    writeFileSync(join(dir, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: alpha\n---\n");
    writeFileSync(
      join(dir, "alpha", "evals", "triggers.yaml"),
      `skill: alpha\nruns: 1\nshould_trigger: ["do alpha"]\nshould_not_trigger: ["do nothing"]\n`,
    );
    mkdirSync(join(dir, "beta"));
    writeFileSync(join(dir, "beta", "SKILL.md"), "---\nname: beta\ndescription: beta\n---\n");
    const scriptFile = join(dir, "script.json");
    writeFileSync(scriptFile, JSON.stringify({ "do alpha": [["alpha"]], "do nothing": [[]] }));

    await run(["run", dir, "--agent", "fake", "--script", scriptFile, "--format", "json", "--no-cache"]);

    const report = JSON.parse(stdout) as { passed: boolean; skippedSkills: string[] };
    expect(report.skippedSkills).toEqual(["beta"]);
    expect(report.passed).toBe(true);
    expect(stderr).toMatch(/beta/);
  });

  it("refuses an unsafe pack before calling any agent, even one that stages nothing", async () => {
    const { packDir, scriptFile } = pack({ "do alpha": [["alpha"]], "do nothing": [[]] });
    symlinkSync(scriptFile, join(packDir, "alpha", "leak.json"));

    await expect(run(["run", packDir, "--agent", "fake", "--script", scriptFile, "--no-cache"])).rejects.toThrow(
      /refusing to stage alpha\/leak.json/,
    );
    expect(stderr).not.toMatch(/agent call/);
  });

  it("wraps the JSON report in a versioned envelope that names what was measured", async () => {
    const { packDir, scriptFile } = pack({ "do alpha": [["alpha"]], "do nothing": [[]] });

    await run(["run", packDir, "--agent", "fake", "--script", scriptFile, "--format", "json", "--no-cache"]);

    const report = JSON.parse(stdout) as { schemaVersion: number; run: Record<string, unknown>; passed: boolean };
    expect(report.schemaVersion).toBe(2);
    expect(report.passed).toBe(true);
    expect(report.run).toMatchObject({ agent: "fake", model: null });
    expect(report.run.skillcaller).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.run.agentVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(report.run.packDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("counts samples served from the cache separately from fresh ones", async () => {
    const { packDir, scriptFile } = pack({ "do alpha": [["alpha"]], "do nothing": [[]] });
    const cacheDir = mkdtempSync(join(tmpdir(), "skillcaller-cli-cache-"));
    const args = ["run", packDir, "--agent", "fake", "--script", scriptFile, "--format", "json", "--cache-dir", cacheDir];

    await run(args);
    const cold = JSON.parse(stdout) as { skills: { cachedRuns: number }[] };
    stdout = "";
    await run(args);
    const warm = JSON.parse(stdout) as { skills: { cachedRuns: number }[] };

    expect(cold.skills[0]?.cachedRuns).toBe(0);
    expect(warm.skills[0]?.cachedRuns).toBe(2);
  });
});
