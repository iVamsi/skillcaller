import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunOutcome } from "../metrics/types.js";
import { parseClaudeCodeTranscript } from "../transcript/claude-code.js";
import { installPack } from "./install-pack.js";
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

interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly timedOut: boolean;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code";

  constructor(private readonly options: ClaudeCodeAdapterOptions = {}) {}

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
      const result = await this.spawnCli(args, workspace, request.timeoutMs ?? DEFAULT_TIMEOUT_MS, configDir);

      if (result.timedOut) {
        return unusable(`claude timed out after ${request.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
      }

      const transcript = parseClaudeCodeTranscript(result.stdout);
      // --max-turns 1 exits non-zero even when the Skill call was observed
      if (!transcript.usable && result.code !== 0) {
        const detail = result.stderr.trim().slice(0, 300) || `exit code ${result.code}`;
        return unusable(`claude failed: ${detail}`);
      }

      const packSkills = new Set(readdirSync(skillsDir));
      const foreignSkills = transcript.visibleSkills.filter((name) => !packSkills.has(name));

      return {
        invokedSkills: transcript.invokedSkills,
        ...(foreignSkills.length === 0 ? {} : { foreignSkills }),
        usable: transcript.usable,
        ...(transcript.unusableReason === undefined ? {} : { unusableReason: transcript.unusableReason }),
        costUsd: transcript.costUsd,
      };
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      if (configDir !== undefined) rmSync(configDir, { recursive: true, force: true });
    }
  }

  private spawnCli(
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
    configDir: string | undefined,
  ): Promise<SpawnResult> {
    return new Promise((resolve) => {
      const env = { ...process.env };
      if (configDir !== undefined) env["CLAUDE_CONFIG_DIR"] = configDir;

      const child = spawn(this.options.binary ?? "claude", [...args], {
        cwd,
        env,
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
