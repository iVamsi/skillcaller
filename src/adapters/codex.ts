import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunOutcome } from "../metrics/types.js";
import { parseCodexTranscript } from "../transcript/codex.js";
import { installPack } from "./install-pack.js";
import { spawnCli, unusable } from "./spawn-cli.js";
import type { AgentAdapter, RunRequest } from "./types.js";

const DEFAULT_TIMEOUT_MS = 180_000;

export interface CodexAdapterOptions {
  readonly binary?: string;
}

/**
 * Codex has no Skill tool; it reads SKILL.md with a shell command. Home-dir skill
 * reads cannot be switched off without breaking auth (CODEX_HOME), so they are
 * reported as contamination.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";

  constructor(private readonly options: CodexAdapterOptions = {}) {}

  async runPrompt(request: RunRequest): Promise<RunOutcome> {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "skillcaller-codex-ws-")));
    try {
      const skillsDir = join(workspace, ".codex", "skills");
      installPack(request.packDir, skillsDir);
      writeFileSync(join(workspace, "AGENTS.md"), "# skillcaller evaluation workspace\n");

      const args = [
        "exec",
        "--json",
        "--sandbox", "read-only",
        "--skip-git-repo-check",
        "-C", workspace,
      ];
      if (request.model !== undefined) args.push("--model", request.model);
      args.push(request.prompt);

      const result = await spawnCli(
        this.options.binary ?? "codex",
        args,
        workspace,
        request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      if (result.timedOut) {
        return unusable(`codex timed out after ${request.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
      }

      const transcript = parseCodexTranscript(result.stdout, skillsDir);
      if (!transcript.usable && result.code !== 0) {
        const detail = result.stderr.trim().slice(0, 300) || `exit code ${result.code}`;
        return unusable(`codex failed: ${detail}`);
      }

      return {
        invokedSkills: transcript.invokedSkills,
        ...(transcript.foreignSkills.length === 0 ? {} : { foreignSkills: transcript.foreignSkills }),
        usable: transcript.usable,
        ...(transcript.unusableReason === undefined ? {} : { unusableReason: transcript.unusableReason }),
        costUsd: 0, // Codex does not report per-run cost in its JSONL output.
      };
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
}
