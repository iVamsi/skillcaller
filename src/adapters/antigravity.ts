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

interface PluginSession {
  readonly pluginDir: string;
  readonly pluginName: string;
  readonly packDir: string;
  readonly skillsDir: string;
}

/**
 * Runs Antigravity CLI headless (`agy -p`). Workspace `.agents/skills` is ignored;
 * skills load via `agy plugin install`. Redirecting HOME breaks auth, so other
 * user skills stay visible and are reported as contamination.
 */
export class AntigravityAdapter implements AgentAdapter {
  readonly id = "antigravity";
  private session: PluginSession | undefined;
  private gate: Promise<void> = Promise.resolve();

  constructor(private readonly options: AntigravityAdapterOptions = {}) {}

  async runPrompt(request: RunRequest): Promise<RunOutcome> {
    const plugin = await this.ensurePlugin(request.packDir);
    if ("usable" in plugin) return plugin;

    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "skillcaller-agy-ws-")));
    try {
      const args = ["-p", request.prompt, "--output-format", "stream-json", "--sandbox"];
      if (request.model !== undefined) args.push("--model", request.model);

      const binary = this.options.binary ?? "agy";
      const result = await this.spawnCli(args, workspace, request.timeoutMs ?? DEFAULT_TIMEOUT_MS, binary);
      if (result.timedOut) {
        return unusable(`agy timed out after ${request.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
      }

      const combined = `${result.stdout}\n${result.stderr}`;
      if (/authentication required/i.test(combined)) {
        return unusable("agent reported it is not logged in; no skill decision was made");
      }

      const transcript = parseAntigravityTranscript(result.stdout, plugin.skillsDir);
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
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  async close(): Promise<void> {
    await this.locked(() => this.teardown());
  }

  private async ensurePlugin(packDir: string): Promise<PluginSession | RunOutcome> {
    return this.locked(async () => {
      if (this.session?.packDir === packDir) return this.session;
      if (this.session !== undefined) await this.teardown();
      return this.install(packDir);
    });
  }

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.gate;
    let release!: () => void;
    this.gate = new Promise((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async install(packDir: string): Promise<PluginSession | RunOutcome> {
    const pluginDir = realpathSync(mkdtempSync(join(tmpdir(), "skillcaller-agy-plugin-")));
    const pluginName = `sc${randomBytes(8).toString("hex")}`;
    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ name: pluginName, description: "skillcaller evaluation pack" }),
    );
    installPack(packDir, join(pluginDir, "skills"));

    const binary = this.options.binary ?? "agy";
    const result = await this.spawnCli(["plugin", "install", pluginDir], pluginDir, PLUGIN_TIMEOUT_MS, binary);
    if (result.timedOut) {
      rmSync(pluginDir, { recursive: true, force: true });
      return unusable(`agy plugin install timed out after ${PLUGIN_TIMEOUT_MS}ms`);
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim().slice(0, 300) || `exit code ${result.code}`;
      rmSync(pluginDir, { recursive: true, force: true });
      return unusable(`agy plugin install failed: ${detail}`);
    }

    this.session = {
      pluginDir,
      pluginName,
      packDir,
      skillsDir: join(homedir(), ".gemini", "config", "plugins", pluginName, "skills"),
    };
    return this.session;
  }

  private async teardown(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session === undefined) return;
    await this.spawnCli(
      ["plugin", "uninstall", session.pluginName],
      session.pluginDir,
      PLUGIN_TIMEOUT_MS,
      this.options.binary ?? "agy",
    );
    rmSync(session.pluginDir, { recursive: true, force: true });
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
