import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { RunOutcome } from "../metrics/types.js";
import { parseAntigravityTranscript } from "../transcript/antigravity.js";
import { installPack } from "./install-pack.js";
import { cliVersion, spawnCli, spawnFailure, unusable, type SpawnResult } from "./spawn-cli.js";
import type { AgentAdapter, RunRequest } from "./types.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const PLUGIN_TIMEOUT_MS = 30_000;

export interface AntigravityAdapterOptions {
  readonly binary?: string;
  /** Where agy installs plugins. Tests point it at a temp dir. */
  readonly pluginsRoot?: string;
  /** Where this adapter records the plugins it owns, so a killed run can be cleaned up later. */
  readonly journalDir?: string;
}

interface PluginRecord {
  readonly pluginName: string;
  readonly pluginDir: string;
  readonly pid: number;
}

interface PluginSession extends PluginRecord {
  readonly packDir: string;
  readonly skillsDir: string;
}

/**
 * Runs Antigravity CLI headless (`agy -p`). Workspace `.agents/skills` is ignored;
 * skills load via `agy plugin install`. Redirecting HOME breaks auth, so other
 * user skills stay visible and are reported as contamination.
 *
 * Each installed plugin is recorded in the journal before install and forgotten only after a
 * confirmed uninstall. A later run removes plugins whose owning process has died.
 */
export class AntigravityAdapter implements AgentAdapter {
  readonly id = "antigravity";
  private session: PluginSession | undefined;
  private gate: Promise<void> = Promise.resolve();
  private recovered = false;
  private readonly binary: string;
  private readonly pluginsRoot: string;
  private readonly journalDir: string;

  constructor(options: AntigravityAdapterOptions = {}) {
    this.binary = options.binary ?? "agy";
    this.pluginsRoot = options.pluginsRoot ?? join(homedir(), ".gemini", "config", "plugins");
    this.journalDir = options.journalDir ?? join(tmpdir(), `skillcaller-agy-owned-${userInfo().username}`);
  }

  version(): Promise<string> {
    return cliVersion(this.binary);
  }

  async runPrompt(request: RunRequest): Promise<RunOutcome> {
    const plugin = await this.ensurePlugin(request.packDir);
    if ("usable" in plugin) return plugin;

    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "skillcaller-agy-ws-")));
    try {
      const args = ["-p", request.prompt, "--output-format", "stream-json", "--sandbox"];
      if (request.model !== undefined) args.push("--model", request.model);

      const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const result = await spawnCli(this.binary, args, {
        cwd: workspace,
        timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const stopped = spawnFailure("agy", result, timeoutMs);
      if (stopped !== undefined) return stopped;

      const combined = `${result.stdout}\n${result.stderr}`;
      if (/authentication required/i.test(combined)) {
        return unusable("agent reported it is not logged in; no skill decision was made", "auth");
      }

      const transcript = parseAntigravityTranscript(result.stdout, plugin.skillsDir);
      if (!transcript.usable && result.code !== 0) {
        return unusable(`agy failed: ${detail(result)}`, "agent-error");
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

  /** Rejects when the plugin could not be removed; the record stays so a later run can retry. */
  async close(): Promise<void> {
    await this.locked(() => this.teardown());
  }

  private async ensurePlugin(packDir: string): Promise<PluginSession | RunOutcome> {
    return this.locked(async () => {
      if (this.session?.packDir === packDir) return this.session;
      if (this.session !== undefined) await this.teardown();
      if (!this.recovered) {
        this.recovered = true;
        await this.recoverAbandoned();
      }
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
    const record: PluginRecord = { pluginName, pluginDir, pid: process.pid };
    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ name: pluginName, description: "skillcaller evaluation pack" }),
    );
    installPack(packDir, join(pluginDir, "skills"));
    mkdirSync(this.journalDir, { recursive: true });
    writeFileSync(this.recordFile(pluginName), JSON.stringify(record));

    const result = await spawnCli(this.binary, ["plugin", "install", pluginDir], {
      cwd: pluginDir,
      timeoutMs: PLUGIN_TIMEOUT_MS,
    });
    if (result.failure === undefined && result.code === 0) {
      this.session = { ...record, packDir, skillsDir: join(this.pluginsRoot, pluginName, "skills") };
      return this.session;
    }

    const cleanup = await this.remove(record);
    const why =
      result.failure === "timeout" ? `timed out after ${PLUGIN_TIMEOUT_MS}ms` : `failed: ${detail(result)}`;
    return unusable(`agy plugin install ${why}${cleanup === undefined ? "" : `; ${cleanup}`}`, "setup");
  }

  private async teardown(): Promise<void> {
    if (this.session === undefined) return;
    const problem = await this.remove(this.session);
    if (problem !== undefined) throw new Error(problem);
    this.session = undefined;
  }

  /**
   * Removes an owned plugin. Returns a description of the problem, or undefined once it is gone.
   * A failed uninstall of a plugin that never landed on disk is not a problem.
   */
  private async remove(record: PluginRecord): Promise<string | undefined> {
    const result = await spawnCli(this.binary, ["plugin", "uninstall", record.pluginName], {
      cwd: tmpdir(),
      timeoutMs: PLUGIN_TIMEOUT_MS,
    });
    const failed = result.failure !== undefined || result.code !== 0;
    if (failed && existsSync(join(this.pluginsRoot, record.pluginName))) {
      return (
        `could not remove Antigravity plugin ${record.pluginName} (${detail(result)}); ` +
        `run "agy plugin uninstall ${record.pluginName}"`
      );
    }
    rmSync(record.pluginDir, { recursive: true, force: true });
    rmSync(this.recordFile(record.pluginName), { force: true });
    return undefined;
  }

  /** Removes plugins recorded by runs whose process has died, by their exact recorded name. */
  private async recoverAbandoned(): Promise<void> {
    let files: string[];
    try {
      files = readdirSync(this.journalDir).filter((name) => name.endsWith(".json"));
    } catch {
      return;
    }
    for (const file of files) {
      const record = readRecord(join(this.journalDir, file));
      if (record === undefined || isAlive(record.pid)) continue;
      const problem = await this.remove(record);
      if (problem !== undefined) process.stderr.write(`warning: ${problem}\n`);
    }
  }

  private recordFile(pluginName: string): string {
    return join(this.journalDir, `${pluginName}.json`);
  }
}

function detail(result: SpawnResult): string {
  return result.stderr.trim().slice(0, 300) || result.failure || `exit code ${result.code}`;
}

function readRecord(file: string): PluginRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<PluginRecord>;
    // The name becomes a CLI argument, so accept only names this adapter generates
    if (typeof value.pluginName !== "string" || !/^sc[0-9a-z]+$/.test(value.pluginName)) return undefined;
    if (typeof value.pluginDir !== "string" || typeof value.pid !== "number") return undefined;
    return { pluginName: value.pluginName, pluginDir: value.pluginDir, pid: value.pid };
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
