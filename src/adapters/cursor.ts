import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunOutcome } from "../metrics/types.js";
import { parseCursorTranscript } from "../transcript/cursor.js";
import { installPack } from "./install-pack.js";
import { cliVersion, spawnCli, spawnFailure, unusable } from "./spawn-cli.js";
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

  version(): Promise<string> {
    return cliVersion(this.options.binary ?? "cursor-agent");
  }

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

      const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const result = await spawnCli(this.options.binary ?? "cursor-agent", args, {
        cwd: workspace,
        timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const stopped = spawnFailure("cursor", result, timeoutMs);
      if (stopped !== undefined) return stopped;

      const transcript = parseCursorTranscript(result.stdout, skillsDir);
      if (!transcript.usable && result.code !== 0) {
        const detail = result.stderr.trim().slice(0, 300) || `exit code ${result.code}`;
        return unusable(`cursor failed: ${detail}`, "agent-error");
      }

      return {
        invokedSkills: transcript.invokedSkills,
        ...(transcript.foreignSkills.length === 0 ? {} : { foreignSkills: transcript.foreignSkills }),
        usable: transcript.usable,
        ...(transcript.unusableReason === undefined ? {} : { unusableReason: transcript.unusableReason }),
        ...(transcript.unusableCode === undefined ? {} : { unusableCode: transcript.unusableCode }),
      };
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
}
