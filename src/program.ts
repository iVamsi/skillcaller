import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { AntigravityAdapter } from "./adapters/antigravity.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { CodexAdapter } from "./adapters/codex.js";
import { CursorAdapter } from "./adapters/cursor.js";
import { FakeAdapter } from "./adapters/fake.js";
import type { AgentAdapter } from "./adapters/types.js";
import { CachingAdapter } from "./cache/caching-adapter.js";
import { positiveInt, rate } from "./cli-options.js";
import { buildCollisionMatrix, type CorpusOutcomes } from "./metrics/collisions.js";
import { scoreSkill } from "./metrics/score.js";
import type { SkillReport } from "./metrics/types.js";
import { loadPack, type Pack } from "./pack/load-pack.js";
import { renderJUnit, renderJson, renderMarkdown, renderTerminal, runPassed } from "./report/render.js";
import { runPackCorpora } from "./runner/run-corpus.js";

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
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const FORMATS = ["terminal", "json", "markdown", "junit"] as const;

function agentCallCount(pack: Pack): number {
  let total = 0;
  for (const entry of pack.entries) {
    const prompts = entry.corpus.shouldTrigger.length + entry.corpus.shouldNotTrigger.length;
    total += prompts * entry.corpus.runs;
  }
  return total;
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
  const base = adapterFor(flags.agent, flags.script);
  const adapter = flags.cache ? new CachingAdapter(base, flags.cacheDir) : base;
  try {
    await measurePack(pack, adapter, flags);
  } finally {
    await adapter.close?.();
  }
}

async function measurePack(pack: Pack, adapter: AgentAdapter, flags: RunFlags): Promise<void> {
  const model = flags.model ?? (flags.agent === "claude-code" ? DEFAULT_MODEL : undefined);
  const timeoutMs = flags.timeout === undefined ? undefined : positiveInt(flags.timeout, 180_000, "--timeout");
  const concurrency = positiveInt(flags.concurrency, 2, "--concurrency");
  const calls = agentCallCount(pack);
  process.stderr.write(
    `skillcaller: ${calls} agent call${calls === 1 ? "" : "s"} across ${pack.entries.length} skill${pack.entries.length === 1 ? "" : "s"} (concurrency ${concurrency})\n`,
  );

  for (const skill of pack.skillsWithoutCorpus) {
    process.stderr.write(`warning: skill "${skill}" ships no evals/triggers.yaml and was not measured\n`);
  }

  const reports: SkillReport[] = [];
  const corpora: CorpusOutcomes[] = [];

  let completedSkills = 0;
  const allOutcomes = await runPackCorpora(pack.entries, adapter, {
    packDir: pack.root,
    ...(model === undefined ? {} : { model }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    concurrency,
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

  const output =
    flags.format === "json"
      ? renderJson(reports, matrix)
      : flags.format === "markdown"
        ? renderMarkdown(reports, matrix)
        : flags.format === "junit"
          ? renderJUnit(reports, matrix)
          : renderTerminal(reports, matrix);
  process.stdout.write(`${output}\n`);

  process.exitCode = runPassed(reports, matrix) ? 0 : 1;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("skillcaller")
    .description("Trigger-reliability evals for Agent Skills")
    .version("0.1.1");

  program
    .command("run")
    .argument("[pack]", "directory of skills (defaults to auto-discovering ./skills, .agents/skills, .claude/skills, or .cursor/skills)")
    .option("-a, --agent <agent>", "claude-code, codex, cursor, antigravity or fake", "claude-code")
    .option("-m, --model <model>", "model to evaluate against")
    .option("-c, --concurrency <n>", "parallel agent runs", "2")
    .option("-t, --timeout <ms>", "per-prompt agent timeout in milliseconds")
    .option("-f, --format <format>", "terminal, json, markdown or junit", "terminal")
    .option("--script <file>", "scripted outcomes for the fake agent")
    .option("--collision-threshold <rate>", "report a collision at or above this rate", "0.2")
    .option("--no-cache", "re-run every prompt instead of reusing cached answers")
    .option("--cache-dir <dir>", "where cached answers live", ".skillcaller-cache")
    .description("Measure how reliably each skill triggers")
    .action(runPack);

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
