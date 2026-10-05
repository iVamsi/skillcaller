import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { AntigravityAdapter } from "./adapters/antigravity.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { CodexAdapter } from "./adapters/codex.js";
import { CursorAdapter } from "./adapters/cursor.js";
import { FakeAdapter } from "./adapters/fake.js";
import { installPack } from "./adapters/install-pack.js";
import type { AgentAdapter } from "./adapters/types.js";
import { CachingAdapter } from "./cache/caching-adapter.js";
import { positiveInt, rate } from "./cli-options.js";
import { AgentUnavailableError } from "./adapters/spawn-cli.js";
import { compareReports, loadReport, renderComparison } from "./commands/compare.js";
import { diagnose, renderDiagnosis } from "./commands/doctor.js";
import { planPack, renderPlan } from "./commands/plan.js";
import { validatePack } from "./commands/validate.js";
import { buildCollisionMatrix, type CollisionMatrix, type CorpusOutcomes } from "./metrics/collisions.js";
import { scoreSkill } from "./metrics/score.js";
import type { RunOutcome, SkillReport } from "./metrics/types.js";
import { loadPack, type Pack } from "./pack/load-pack.js";
import {
  hidePrompts,
  renderJUnit,
  renderJson,
  renderMarkdown,
  renderTerminal,
  runPassed,
  type RunInfo,
} from "./report/render.js";
import { runPackCorpora } from "./runner/run-corpus.js";
import { VERSION } from "./version.js";

export const STANDARD_SKILL_DIRS = [
  "skills",
  ".agents/skills",
  ".claude/skills",
  ".cursor/skills",
] as const;

export function resolvePackDir(packDir: string | undefined, cwd: string = process.cwd()): string | undefined {
  if (packDir !== undefined) return packDir;
  for (const candidate of STANDARD_SKILL_DIRS) {
    const fullPath = join(cwd, candidate);
    if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
      return candidate;
    }
  }
  return undefined;
}

function adapterFor(name: string, scriptPath: string | undefined): AgentAdapter {
  switch (name) {
    case "claude-code":
      return new ClaudeCodeAdapter();
    case "codex":
      return new CodexAdapter();
    case "cursor":
      return new CursorAdapter();
    case "antigravity":
      return new AntigravityAdapter();
    case "fake":
      return scriptPath === undefined ? new FakeAdapter() : FakeAdapter.fromFile(scriptPath);
    default:
      throw new Error(`unknown agent "${name}"; expected claude-code, codex, cursor, antigravity or fake`);
  }
}

interface RunFlags {
  readonly agent: string;
  readonly model?: string;
  readonly concurrency: string;
  readonly timeout?: string;
  readonly format: string;
  readonly script?: string;
  readonly collisionThreshold: string;
  readonly cache: boolean;
  readonly cacheDir: string;
  readonly maxCalls: string;
  readonly deadline?: string;
  readonly maxCost?: string;
  readonly output?: string;
  readonly hidePrompts?: boolean;
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const FORMATS = ["terminal", "json", "markdown", "junit"] as const;

/** Limits guard spend, so a typo must stop the run rather than fall back to no limit. */
function limit(raw: string, label: string, integer: boolean): number {
  const value = /^\d*\.?\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN;
  if (!(value > 0) || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} expects a ${integer ? "whole number" : "number"} above 0, got "${raw}"`);
  }
  return value;
}

/** Aborts the run once fresh spend reaches the budget. Cached answers cost nothing. */
export function watchBudget(maxCostUsd: number, controller: AbortController): (outcome: RunOutcome) => void {
  let spent = 0;
  return (outcome) => {
    spent += outcome.costUsd ?? 0;
    if (spent >= maxCostUsd && !controller.signal.aborted) {
      controller.abort(new Error(`spend reached the --max-cost budget of $${maxCostUsd.toFixed(2)}`));
    }
  };
}

function agentCallCount(pack: Pack): number {
  let total = 0;
  for (const entry of pack.entries) {
    const prompts = entry.corpus.shouldTrigger.length + entry.corpus.shouldNotTrigger.length;
    total += prompts * entry.corpus.runs;
  }
  return total;
}

function requirePackDir(packArg: string | undefined): string {
  const packDir = resolvePackDir(packArg);
  if (packDir === undefined) {
    throw new Error(
      `no skill pack path provided, and none of ${STANDARD_SKILL_DIRS.map((d) => `"${d}"`).join(", ")} exist in the current directory`,
    );
  }
  return packDir;
}

function defaultModel(flags: { agent: string; model?: string }): string | undefined {
  return flags.model ?? (flags.agent === "claude-code" ? DEFAULT_MODEL : undefined);
}

/** Null when the CLI runs but cannot say its version. A CLI that cannot start stops the run here, once. */
async function agentVersion(adapter: AgentAdapter, agent: string): Promise<string | null> {
  if (adapter.version === undefined) return null;
  try {
    return await adapter.version();
  } catch (error) {
    if (error instanceof AgentUnavailableError) {
      throw new Error(`${error.message}; run "skillcaller doctor --agent ${agent}" to check the setup`);
    }
    return null;
  }
}

function compareCommand(baseline: string, candidate: string, flags: { format: string; maxDrop: string }): void {
  if (flags.format !== "terminal" && flags.format !== "markdown" && flags.format !== "json") {
    throw new Error(`--format expects terminal, markdown or json, got "${flags.format}"`);
  }
  const comparison = compareReports(loadReport(baseline), loadReport(candidate), {
    maxDrop: rate(flags.maxDrop, 0.1, "--max-drop"),
  });
  const output =
    flags.format === "json" ? JSON.stringify(comparison, null, 2) : renderComparison(comparison, flags.format);
  process.stdout.write(`${output}\n`);
  process.exitCode = comparison.comparable && comparison.regressions.length === 0 ? 0 : 1;
}

async function doctorCommand(flags: { agent: string; format: string }): Promise<void> {
  const diagnosis = await diagnose(flags.agent);
  process.stdout.write(`${flags.format === "json" ? JSON.stringify(diagnosis, null, 2) : renderDiagnosis(diagnosis)}\n`);
  process.exitCode = diagnosis.ok ? 0 : 1;
}

function validateCommand(packArg: string | undefined): void {
  const { errors, warnings } = validatePack(requirePackDir(packArg));
  const lines = [...errors.map((e) => `error: ${e}`), ...warnings.map((w) => `warning: ${w}`)];
  lines.push(errors.length === 0 ? "Pack is valid." : `${errors.length} problem(s) found.`);
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exitCode = errors.length === 0 ? 0 : 1;
}

async function planCommand(packArg: string | undefined, flags: RunFlags): Promise<void> {
  if (flags.format !== "terminal" && flags.format !== "json") {
    throw new Error(`--format expects terminal or json, got "${flags.format}"`);
  }
  const pack = loadPack(requirePackDir(packArg));
  const model = defaultModel(flags);
  const timeoutMs = flags.timeout === undefined ? undefined : positiveInt(flags.timeout, 180_000, "--timeout");
  const plan = planPack(pack, {
    agent: flags.agent,
    concurrency: positiveInt(flags.concurrency, 2, "--concurrency"),
    ...(model === undefined ? {} : { model }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

  let cachedCalls: number | undefined;
  if (flags.cache) {
    const cache = new CachingAdapter(adapterFor(flags.agent, flags.script), flags.cacheDir);
    cachedCalls = await cache.countCached(
      plan.skills.flatMap((skill) =>
        skill.cases.flatMap((c) =>
          Array.from({ length: skill.runs }, () => ({
            prompt: c.prompt,
            packDir: pack.root,
            ...(model === undefined ? {} : { model }),
            ...(skill.timeoutMs === null ? {} : { timeoutMs: skill.timeoutMs }),
          })),
        ),
      ),
    );
  }
  const full = cachedCalls === undefined ? plan : { ...plan, cachedCalls };
  process.stdout.write(`${flags.format === "json" ? JSON.stringify(full, null, 2) : renderPlan(full)}\n`);
}

async function runPack(packArg: string | undefined, flags: RunFlags): Promise<void> {
  if (!FORMATS.includes(flags.format as (typeof FORMATS)[number])) {
    process.stderr.write(`skillcaller: --format expects one of ${FORMATS.join(", ")}, got "${flags.format}"\n`);
    process.exitCode = 1;
    return;
  }
  const packDir = resolvePackDir(packArg);
  if (packDir === undefined) {
    process.stderr.write(
      `skillcaller: no skill pack path provided, and none of ${STANDARD_SKILL_DIRS.map((d) => `"${d}"`).join(", ")} exist in the current directory\n`,
    );
    process.exitCode = 1;
    return;
  }
  const pack = loadPack(packDir);
  const calls = agentCallCount(pack);
  const maxCalls = limit(flags.maxCalls, "--max-calls", true);
  if (calls > maxCalls) {
    throw new Error(`${calls} agent calls exceeds --max-calls ${maxCalls}; raise it to run this pack`);
  }
  // Agents stage from this copy, so edits to the source pack mid-run cannot change what is measured
  const snapshot = mkdtempSync(join(tmpdir(), "skillcaller-pack-"));
  try {
    const packDigest = installPack(pack.root, snapshot);
    const base = adapterFor(flags.agent, flags.script);
    const adapter = flags.cache ? new CachingAdapter(base, flags.cacheDir) : base;
    try {
      const model = defaultModel(flags);
      const run: RunInfo = {
        skillcaller: VERSION,
        agent: base.id,
        agentVersion: await agentVersion(base, flags.agent),
        model: model ?? null,
        packDigest,
      };
      await measurePack({ ...pack, root: snapshot }, adapter, flags, run);
    } finally {
      await adapter.close?.();
    }
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

async function measurePack(pack: Pack, adapter: AgentAdapter, flags: RunFlags, info: RunInfo): Promise<void> {
  const model = info.model ?? undefined;
  const controller = new AbortController();
  const interrupt = (signal: NodeJS.Signals) => () => controller.abort(new Error(`interrupted by ${signal}`));
  const onSigint = interrupt("SIGINT");
  const onSigterm = interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const deadlineMs = flags.deadline === undefined ? undefined : limit(flags.deadline, "--deadline", true);
  const deadline =
    deadlineMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(new Error(`hit the --deadline of ${deadlineMs}ms`)), deadlineMs);
  const onOutcome =
    flags.maxCost === undefined ? undefined : watchBudget(limit(flags.maxCost, "--max-cost", false), controller);
  try {
    await measureUntilStopped(pack, adapter, flags, info, model, controller.signal, onOutcome);
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

async function measureUntilStopped(
  pack: Pack,
  adapter: AgentAdapter,
  flags: RunFlags,
  info: RunInfo,
  model: string | undefined,
  signal: AbortSignal,
  onOutcome: ((outcome: RunOutcome) => void) | undefined,
): Promise<void> {
  const timeoutMs = flags.timeout === undefined ? undefined : positiveInt(flags.timeout, 180_000, "--timeout");
  const concurrency = positiveInt(flags.concurrency, 2, "--concurrency");
  const calls = agentCallCount(pack);
  process.stderr.write(
    `skillcaller: ${calls} agent call${calls === 1 ? "" : "s"} across ${pack.entries.length} skill${pack.entries.length === 1 ? "" : "s"} (concurrency ${concurrency})\n`,
  );

  for (const skill of pack.skillsWithoutCorpus) {
    process.stderr.write(`warning: skill "${skill}" ships no evals/triggers.yaml and was not measured\n`);
  }

  if (pack.entries.length === 0) {
    writeReport(flags, [], buildCollisionMatrix([]), pack.skillsWithoutCorpus, { ...info, durationMs: 0 });
    process.exitCode = 1;
    return;
  }

  const reports: SkillReport[] = [];
  const corpora: CorpusOutcomes[] = [];

  let completedSkills = 0;
  const started = performance.now();
  const allOutcomes = await runPackCorpora(pack.entries, adapter, {
    packDir: pack.root,
    ...(model === undefined ? {} : { model }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    concurrency,
    signal,
    ...(onOutcome === undefined ? {} : { onOutcome }),
    onProgress: (completed, total) => {
      if (flags.format === "terminal" && process.stderr.isTTY === true) {
        process.stderr.write(`\rprogress: ${completed}/${total} runs`);
      }
    },
    onSkillComplete: (skill) => {
      completedSkills += 1;
      if (flags.format === "terminal") {
        if (process.stderr.isTTY === true) {
          process.stderr.write(`\r${skill}: evaluated (${completedSkills}/${pack.entries.length} skills)\n`);
        } else {
          process.stderr.write(`${skill}: evaluated\n`);
        }
      }
    },
  });

  for (let i = 0; i < pack.entries.length; i++) {
    const entry = pack.entries[i];
    if (entry === undefined) continue;
    const outcomes = allOutcomes[i] ?? [];
    reports.push(scoreSkill(entry.corpus, outcomes));
    corpora.push({ skill: entry.corpus.skill, outcomes });
  }

  const matrix = buildCollisionMatrix(corpora, {
    threshold: rate(flags.collisionThreshold, 0.2, "--collision-threshold"),
  });

  const stoppedEarly = signal.aborted ? (signal.reason as Error).message : undefined;
  if (stoppedEarly !== undefined) {
    process.stderr.write(`skillcaller: stopped early (${stoppedEarly}); unfinished prompts were not measured\n`);
  }
  const durationMs = Math.round(performance.now() - started);
  const run: RunInfo = { ...info, durationMs, ...(stoppedEarly === undefined ? {} : { stoppedEarly }) };
  writeReport(flags, flags.hidePrompts === true ? hidePrompts(reports) : reports, matrix, pack.skillsWithoutCorpus, run);
  process.exitCode = stoppedEarly === undefined && runPassed(reports, matrix) ? 0 : 1;
}

function writeReport(
  flags: RunFlags,
  reports: readonly SkillReport[],
  matrix: CollisionMatrix,
  skippedSkills: readonly string[],
  run: RunInfo,
): void {
  const format = flags.format;
  const output =
    format === "json"
      ? renderJson(reports, matrix, skippedSkills, run)
      : format === "markdown"
        ? renderMarkdown(reports, matrix, skippedSkills)
        : format === "junit"
          ? renderJUnit(reports, matrix, skippedSkills)
          : renderTerminal(reports, matrix, {
              skippedSkills,
              ...(run.stoppedEarly === undefined ? {} : { stoppedEarly: run.stoppedEarly }),
            });
  if (flags.output === undefined) {
    process.stdout.write(`${output}\n`);
    return;
  }
  // Renamed into place, so a reader never sees a half-written report
  const temp = `${flags.output}.${process.pid}.tmp`;
  writeFileSync(temp, `${output}\n`);
  renameSync(temp, flags.output);
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("skillcaller")
    .description("Trigger-reliability evals for Agent Skills")
    .version(VERSION);

  const withExecutionOptions = (command: Command): Command =>
    command
      .argument("[pack]", "directory of skills (defaults to auto-discovering ./skills, .agents/skills, .claude/skills, or .cursor/skills)")
      .option("-a, --agent <agent>", "claude-code, codex, cursor, antigravity or fake", "claude-code")
      .option("-m, --model <model>", "model to evaluate against")
      .option("-c, --concurrency <n>", "parallel agent runs", "2")
      .option("-t, --timeout <ms>", "per-prompt agent timeout in milliseconds")
      .option("--script <file>", "scripted outcomes for the fake agent")
      .option("--no-cache", "re-run every prompt instead of reusing cached answers")
      .option("--cache-dir <dir>", "where cached answers live", ".skillcaller-cache");

  withExecutionOptions(program.command("run"))
    .option("-f, --format <format>", "terminal, json, markdown or junit", "terminal")
    .option(
      "--collision-threshold <rate>",
      "report a collision at or above this rate (0 = any positive rate, 1 = every run)",
      "0.2",
    )
    .option("--max-calls <n>", "refuse to start a run needing more agent calls than this", "1000")
    .option("--deadline <ms>", "stop the whole run after this many milliseconds")
    .option("--max-cost <usd>", "stop the run once fresh spend reaches this many dollars")
    .option("-o, --output <file>", "write the report to this file instead of stdout")
    .option("--hide-prompts", "replace prompt text with case ids, for reports shared outside the team")
    .description("Measure how reliably each skill triggers")
    .action(runPack);

  withExecutionOptions(program.command("plan"))
    .option("-f, --format <format>", "terminal or json", "terminal")
    .description("Show what a run would do, without calling an agent")
    .action(planCommand);

  program
    .command("compare")
    .argument("<baseline>", "JSON report from the baseline run")
    .argument("<candidate>", "JSON report from the candidate run")
    .option("-f, --format <format>", "terminal, markdown or json", "terminal")
    .option("--max-drop <rate>", "how much a case may worsen before it counts as a regression", "0.1")
    .description("Find regressions between two JSON reports")
    .action(compareCommand);

  program
    .command("doctor")
    .option("-a, --agent <agent>", "claude-code, codex, cursor or antigravity", "claude-code")
    .option("-f, --format <format>", "terminal or json", "terminal")
    .description("Check that an agent CLI is installed and usable, without sending a prompt")
    .action(doctorCommand);

  program
    .command("validate")
    .argument("[pack]", "directory of skills (defaults to auto-discovering standard directories)")
    .description("Check skills and corpora for problems, without calling an agent")
    .action(validateCommand);

  program
    .command("init")
    .argument("<skill-dir>", "skill directory to scaffold a corpus in")
    .description("Create evals/triggers.yaml for a skill")
    .action((skillDir: string) => {
      const name = skillDir.replace(/\/+$/, "").split("/").pop() ?? "my-skill";
      mkdirSync(join(skillDir, "evals"), { recursive: true });
      const file = join(skillDir, "evals", "triggers.yaml");
      try {
        writeFileSync(
          file,
          `skill: ${name}
# Repeats per prompt. Activation is a rate, so one run proves nothing.
runs: 5
gates:
  trigger: 0.9
  no_trigger: 0.05

# Replace these with phrasings a user would type, including symptoms.
should_trigger:
  - "help me with ${name}"

# Adjacent work this skill must stay out of.
should_not_trigger:
  - "rename this variable"
`,
          { flag: "wx" },
        );
        process.stdout.write(`created ${file}\n`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          process.stderr.write(`skillcaller: "${file}" already exists\n`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    });

  return program;
}
