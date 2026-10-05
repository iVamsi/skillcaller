import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { RunOutcome } from "../metrics/types.js";

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** How long output may keep flowing after the CLI exits or is killed. */
const GRACE_MS = 2_000;

export type SpawnFailure = "spawn" | "timeout" | "cancelled" | "output-limit";

export interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly failure?: SpawnFailure;
}

export interface SpawnOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
  readonly graceMs?: number;
}

/**
 * Runs a CLI in its own process group and settles exactly once. The group is killed on timeout,
 * cancellation, the output limit, and after a normal exit, so descendants never outlive the run.
 * `close` alone is not trusted: a grandchild holding the output pipe would delay it forever.
 */
export function spawnCli(binary: string, args: readonly string[], options: SpawnOptions): Promise<SpawnResult> {
  const limit = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const graceMs = options.graceMs ?? GRACE_MS;

  return new Promise((resolve) => {
    if (options.signal?.aborted === true) {
      resolve({ stdout: "", stderr: "", code: null, failure: "cancelled" });
      return;
    }

    // ponytail: process groups are POSIX only; on Windows only the direct child is killed
    const posix = process.platform !== "win32";
    const child = spawn(binary, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: posix,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: SpawnFailure | undefined;
    let code: number | null = null;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;

    const killTree = (): void => {
      try {
        if (posix && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };

    const settle = (extraStderr = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      options.signal?.removeEventListener("abort", onAbort);
      killTree();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8") + extraStderr,
        code,
        ...(failure === undefined ? {} : { failure }),
      });
    };

    const stop = (reason: SpawnFailure): void => {
      failure ??= reason;
      killTree();
      grace ??= setTimeout(() => settle(), graceMs);
    };

    const onAbort = (): void => stop("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);

    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) {
        stop("output-limit");
        return;
      }
      into.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));

    child.on("error", (error) => {
      failure ??= "spawn";
      settle(error.message);
    });
    child.on("exit", (exitCode) => {
      code = exitCode;
      grace ??= setTimeout(() => settle(), graceMs);
    });
    child.on("close", () => settle());
  });
}

const VERSION_TIMEOUT_MS = 15_000;

/** `<binary> --version`, trimmed. Rejects on failure so callers never key a cache on a guess. */
export async function cliVersion(binary: string): Promise<string> {
  const result = await spawnCli(binary, ["--version"], { cwd: tmpdir(), timeoutMs: VERSION_TIMEOUT_MS });
  const version = result.stdout.trim();
  if (result.failure !== undefined || result.code !== 0 || version === "") {
    const detail = result.stderr.trim().slice(0, 300) || (result.failure ?? `exit code ${result.code}`);
    throw new Error(`${binary} --version failed: ${detail}`);
  }
  return version;
}

/** The unusable outcome for a run the supervisor stopped, or undefined when the CLI ran to completion. */
export function spawnFailure(label: string, result: SpawnResult, timeoutMs: number): RunOutcome | undefined {
  switch (result.failure) {
    case undefined:
      return undefined;
    case "timeout":
      return unusable(`${label} timed out after ${timeoutMs}ms`);
    case "cancelled":
      return unusable(`${label} was cancelled before it finished`);
    case "output-limit":
      return unusable(`${label} wrote more output than skillcaller reads, so its transcript is incomplete`);
    case "spawn":
      return unusable(`${label} could not start: ${result.stderr.trim().slice(0, 300)}`);
  }
}

export function unusable(reason: string): RunOutcome {
  return { invokedSkills: [], usable: false, unusableReason: reason };
}
