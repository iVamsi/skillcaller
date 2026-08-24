import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { RunOutcome } from "../metrics/types.js";
import { parseAntigravityTranscript } from "../transcript/antigravity.js";
import { installPack } from "./install-pack.js";
import type { AgentAdapter, RunRequest } from "./types.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const PLUGIN_TIMEOUT_MS = 30_000;

export interface AntigravityAdapterOptions {
  readonly binary?: string;
}

/**
 * Runs Antigravity CLI headless (`agy -p`). Workspace `.agents/skills` is ignored;
 * skills load via `agy plugin install`. Redirecting HOME breaks auth, so other
 * user skills stay visible and are reported as contamination.
 */
export class AntigravityAdapter implements AgentAdapter {
  readonly id = "antigravity";

  constructor(private readonly options: AntigravityAdapterOptions = {}) {}

  async runPrompt(request: RunRequest): Promise<RunOutcome> {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "skillcaller-agy-ws-")));
    const pluginDir = realpathSync(mkdtempSync(join(tmpdir(), "skillcaller-agy-plugin-")));
    const pluginName = `sc${randomBytes(8).toString("hex")}`;
    let installed = false;
    try {
      writeFileSync(
        join(pluginDir, "plugin.json"),
        JSON.stringify({ name: pluginName, description: "skillcaller evaluation pack" }),
      );
      installPack(request.packDir, join(pluginDir, "skills"));

      const binary = this.options.binary ?? "agy";
      const install = await this.spawnCli(["plugin", "install", pluginDir], workspace, PLUGIN_TIMEOUT_MS, binary);
      if (install.timedOut) {
        return unusable(`agy plugin install timed out after ${PLUGIN_TIMEOUT_MS}ms`);
      }
      if (install.code !== 0) {
        const detail = install.stderr.trim().slice(0, 300) || `exit code ${install.code}`;
        return unusable(`agy plugin install failed: ${detail}`);
      }
      installed = true;

      const args = ["-p", request.prompt, "--output-format", "stream-json", "--sandbox"];
      if (request.model !== undefined) args.push("--model", request.model);

      const result = await this.spawnCli(args, workspace, request.timeoutMs ?? DEFAULT_TIMEOUT_MS, binary);
      if (result.timedOut) {
        return unusable(`agy timed out after ${request.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
      }

      const combined = `${result.stdout}\n${result.stderr}`;
      if (/authentication required/i.test(combined)) {
        return unusable("agent reported it is not logged in; no skill decision was made");
      }

      const skillsDir = join(homedir(), ".gemini", "config", "plugins", pluginName, "skills");
      const transcript = parseAntigravityTranscript(result.stdout, skillsDir);
      if (!transcript.usable && result.code !== 0) {
        const detail = result.stderr.trim().slice(0, 300) || `exit code ${result.code}`;
        return unusable(`agy failed: ${detail}`);
      }

      return {
        invokedSkills: transcript.invokedSkills,
        ...(transcript.foreignSkills.length === 0 ? {} : { foreignSkills: transcript.foreignSkills }),
        usable: transcript.usable,
        ...(transcript.unusableReason === undefined ? {} : { unusableReason: transcript.unusableReason }),
        costUsd: 0,
      };
    } finally {
      if (installed) {
        await this.spawnCli(
          ["plugin", "uninstall", pluginName],
          workspace,
          PLUGIN_TIMEOUT_MS,
          this.options.binary ?? "agy",
        );
      }
      rmSync(pluginDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  private spawnCli(
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
    binary: string,
  ): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
    return new Promise((resolve) => {
      const child = spawn(binary, [...args], {
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
