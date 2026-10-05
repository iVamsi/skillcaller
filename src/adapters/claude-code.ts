import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunOutcome } from "../metrics/types.js";
import { parseClaudeCodeTranscript } from "../transcript/claude-code.js";
import { installPack } from "./install-pack.js";
import { cliVersion, spawnCli, spawnFailure, unusable } from "./spawn-cli.js";
import type { AgentAdapter, RunRequest } from "./types.js";

/**
 * Tools other than Skill. `--allowed-tools` does not restrict the real CLI; a name
 * missing from this list still runs. See SECURITY.md.
 */
export const DISALLOWED_TOOLS: readonly string[] = [
  // Filesystem and shell
  "Bash", "BashOutput", "KillBash", "Edit", "MultiEdit", "Write", "Read",
  "NotebookEdit", "NotebookRead", "Glob", "Grep",
  // Network
  "WebFetch", "WebSearch",
  // Delegation
  "Task", "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate",
  "Agent", "ToolSearch", "Workflow", "SlashCommand",
  // Outside the session
  "Artifact", "SendMessage", "DesignSync", "CronCreate", "CronDelete", "CronList",
  "ScheduleWakeup", "PushNotification", "RemoteTrigger",
  // Workspace / planning
  "EnterWorktree", "ExitWorktree", "EnterPlanMode", "ExitPlanMode", "TodoWrite",
  "ReportFindings", "Monitor", "AskUserQuestion",
];

const DEFAULT_TIMEOUT_MS = 120_000;

export interface ClaudeCodeAdapterOptions {
  /** Path to the CLI; tests pass a stub. */
  readonly binary?: string;
  /** Isolate via CLAUDE_CONFIG_DIR. Empty dir has no keychain; needs ANTHROPIC_API_KEY. */
  readonly isolateConfigDir?: boolean;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code";

  constructor(private readonly options: ClaudeCodeAdapterOptions = {}) {}

  version(): Promise<string> {
    return cliVersion(this.options.binary ?? "claude");
  }

  async runPrompt(request: RunRequest): Promise<RunOutcome> {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "skillcaller-ws-")));
    let configDir: string | undefined;
    try {
      const skillsDir = join(workspace, ".claude", "skills");
      installPack(request.packDir, skillsDir);

      const args = [
        "--print", request.prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--max-turns", "1",
        "--disallowed-tools", DISALLOWED_TOOLS.join(","),
        "--setting-sources", "project",
      ];
      if (request.model !== undefined) args.push("--model", request.model);

      configDir = this.options.isolateConfigDir === true ? mkdtempSync(join(tmpdir(), "skillcaller-cfg-")) : undefined;
      const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const result = await spawnCli(this.options.binary ?? "claude", args, {
        cwd: workspace,
        timeoutMs,
        env: configDir === undefined ? process.env : { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const stopped = spawnFailure("claude", result, timeoutMs);
      if (stopped !== undefined) return stopped;

      const transcript = parseClaudeCodeTranscript(result.stdout);
      // --max-turns 1 exits non-zero even when the Skill call was observed
      if (!transcript.usable && result.code !== 0) {
        const detail = result.stderr.trim().slice(0, 300) || `exit code ${result.code}`;
        return unusable(`claude failed: ${detail}`, "agent-error");
      }

      const packSkills = new Set(readdirSync(skillsDir));
      const foreignSkills = transcript.visibleSkills.filter((name) => !packSkills.has(name));

      return {
        invokedSkills: transcript.invokedSkills,
        ...(foreignSkills.length === 0 ? {} : { foreignSkills }),
        usable: transcript.usable,
        ...(transcript.unusableReason === undefined ? {} : { unusableReason: transcript.unusableReason }),
        ...(transcript.unusableCode === undefined ? {} : { unusableCode: transcript.unusableCode }),
        ...(transcript.costUsd === undefined ? {} : { costUsd: transcript.costUsd }),
      };
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      if (configDir !== undefined) rmSync(configDir, { recursive: true, force: true });
    }
  }
}
