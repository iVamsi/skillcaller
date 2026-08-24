import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunOutcome } from "../metrics/types.js";
import { parseCursorTranscript } from "../transcript/cursor.js";
import { installPack } from "./install-pack.js";
import type { AgentAdapter, RunRequest } from "./types.js";

const DEFAULT_TIMEOUT_MS = 180_000;

export interface CursorAdapterOptions {
  readonly binary?: string;
}

/**
 * Runs Cursor Agent headless (`cursor-agent`).
 *
 * Runs in `--mode ask` (read-only mode) so skill instructions cannot execute side effects,
 * with `--trust` to run non-interactively in disposable workspaces.
 */
export class CursorAdapter implements AgentAdapter {
  readonly id = "cursor";

  constructor(private readonly options: CursorAdapterOptions = {}) {}

  async runPrompt(request: RunRequest): Promise<RunOutcome> {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "skillcaller-cursor-ws-")));
    try {
      const skillsDir = join(workspace, ".cursor", "skills");
      installPack(request.packDir, skillsDir);
      writeFileSync(join(workspace, "AGENTS.md"), "# skillcaller evaluation workspace\n");

      const args = [
        "-p",
        "--output-format", "stream-json",
        "--workspace", workspace,
        "--trust",
        "--mode", "ask",
      ];
      if (request.model !== undefined) args.push("--model", request.model);
      args.push(request.prompt);

      const result = await this.spawnCli(args, workspace, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      if (result.timedOut) {
        return unusable(`cursor timed out after ${request.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
      }

      const transcript = parseCursorTranscript(result.stdout, skillsDir);
      if (!transcript.usable && result.code !== 0) {
        const detail = result.stderr.trim().slice(0, 300) || `exit code ${result.code}`;
        return unusable(`cursor failed: ${detail}`);
      }

      return {
        invokedSkills: transcript.invokedSkills,
        ...(transcript.foreignSkills.length === 0 ? {} : { foreignSkills: transcript.foreignSkills }),
        usable: transcript.usable,
        ...(transcript.unusableReason === undefined ? {} : { unusableReason: transcript.unusableReason }),
        costUsd: 0,
      };
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  private spawnCli(
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
    return new Promise((resolve) => {
      const child = spawn(this.options.binary ?? "cursor-agent", [...args], {
        cwd,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
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
}

function unusable(reason: string): RunOutcome {
  return { invokedSkills: [], usable: false, unusableReason: reason, costUsd: 0 };
}
