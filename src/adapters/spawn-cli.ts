import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { RunOutcome } from "../metrics/types.js";

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly timedOut: boolean;
}

export function spawnCli(
  binary: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, [...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}${error.message}`, code: null, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

const VERSION_TIMEOUT_MS = 15_000;

/** `<binary> --version`, trimmed. Rejects on failure so callers never key a cache on a guess. */
export async function cliVersion(binary: string): Promise<string> {
  const result = await spawnCli(binary, ["--version"], tmpdir(), VERSION_TIMEOUT_MS);
  const version = result.stdout.trim();
  if (result.code !== 0 || version === "") {
    const detail = result.stderr.trim().slice(0, 300) || (result.timedOut ? "timed out" : `exit code ${result.code}`);
    throw new Error(`${binary} --version failed: ${detail}`);
  }
  return version;
}

export function unusable(reason: string): RunOutcome {
  return { invokedSkills: [], usable: false, unusableReason: reason };
}
