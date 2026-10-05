import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnCli, spawnFailure, type SpawnFailure } from "../../src/adapters/spawn-cli.js";

function stub(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "skillcaller-spawn-")), "cli");
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Starts a grandchild that inherits stdout and outlives the CLI, recording its pid. */
function leakyCli(pidFile: string, exitImmediately: boolean): string {
  return stub(`
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", "inherit", "inherit"] });
writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
${exitImmediately ? "process.exit(0);" : "setTimeout(() => {}, 60000);"}
`);
}

const cwd = tmpdir();

describe("spawnCli", () => {
  it("settles on timeout even when a grandchild keeps the output pipe open, and kills it", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "skillcaller-pid-")), "pid");
    const started = Date.now();

    const result = await spawnCli(leakyCli(pidFile, false), [], { cwd, timeoutMs: 300, graceMs: 200 });

    expect(result.failure).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });

  it("does not wait for a grandchild that outlives a CLI which exited normally", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "skillcaller-pid-")), "pid");
    const started = Date.now();

    const result = await spawnCli(leakyCli(pidFile, true), [], { cwd, timeoutMs: 30_000, graceMs: 200 });

    expect(result.failure).toBeUndefined();
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });

  it("stops a running CLI when the run is cancelled", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const result = await spawnCli(stub("setTimeout(() => {}, 60000);"), [], {
      cwd,
      timeoutMs: 30_000,
      signal: controller.signal,
    });

    expect(result.failure).toBe("cancelled");
  });

  it("never starts a CLI for a run that was already cancelled", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "skillcaller-marker-")), "ran");
    const controller = new AbortController();
    controller.abort();

    const result = await spawnCli(stub(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "");`), [], {
      cwd,
      timeoutMs: 30_000,
      signal: controller.signal,
    });

    expect(result.failure).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => readFileSync(marker)).toThrow();
  });

  it("reports output past the byte limit instead of silently dropping the rest", async () => {
    const result = await spawnCli(stub(`process.stdout.write("x".repeat(5000));`), [], {
      cwd,
      timeoutMs: 30_000,
      maxOutputBytes: 1000,
    });

    expect(result.failure).toBe("output-limit");
  });

  it("classifies a binary that cannot start", async () => {
    const result = await spawnCli(join(tmpdir(), "skillcaller-no-such-binary"), [], { cwd, timeoutMs: 30_000 });

    expect(result.failure).toBe("spawn");
    expect(result.stderr).toMatch(/ENOENT/);
  });

  it("decodes a multi-byte character split across output chunks", async () => {
    // Each chunk was decoded alone, turning a split "é" into two replacement characters
    const result = await spawnCli(
      stub(`
const bytes = Buffer.from("é");
process.stdout.write(bytes.subarray(0, 1));
setTimeout(() => process.stdout.write(bytes.subarray(1)), 50);
`),
      [],
      { cwd, timeoutMs: 30_000 },
    );

    expect(result.stdout).toBe("é");
  });

  it("labels each way the supervisor stops a run with a reason code", () => {
    const stopped = (failure: SpawnFailure) => spawnFailure("cli", { stdout: "", stderr: "", code: null, failure }, 1);

    expect(stopped("timeout")?.unusableCode).toBe("timeout");
    expect(stopped("cancelled")?.unusableCode).toBe("cancelled");
    expect(stopped("output-limit")?.unusableCode).toBe("output-limit");
    expect(stopped("spawn")?.unusableCode).toBe("agent-missing");
  });
});
