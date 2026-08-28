import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
      expect(stderr).toContain("alpha: 2/2 runs");
    } finally {
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
    }
  });
});

