import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, DISALLOWED_TOOLS } from "../../src/adapters/claude-code.js";

/** A stand-in for the real `claude` binary: records argv/env/cwd, replays a fixture transcript. */
function stubCli(body: string): { path: string; logPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "skillcaller-stub-"));
  const logPath = join(dir, "invocation.json");
  const path = join(dir, "claude");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const { writeFileSync, readdirSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const skillsDir = join(process.cwd(), ".claude", "skills");
writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  visibleSkills: existsSync(skillsDir) ? readdirSync(skillsDir) : [],
  skillContents: existsSync(skillsDir) ? readdirSync(skillsDir).flatMap((s) => readdirSync(join(skillsDir, s))) : [],
}));
${body}
`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return { path, logPath };
}

const invokedTranscript = readFileSync(
  new URL("../../fixtures/claude-code/invoked.ndjson", import.meta.url),
  "utf8",
);

function packWith(skillName: string): string {
  const packDir = mkdtempSync(join(tmpdir(), "skillcaller-pack-"));
  mkdirSync(join(packDir, skillName), { recursive: true });
  writeFileSync(
    join(packDir, skillName, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: test skill\n---\n\nbody\n`,
  );
  return packDir;
}

describe("ClaudeCodeAdapter", () => {
  it("parses a real transcript emitted by the CLI", async () => {
    const stub = stubCli(`process.stdout.write(${JSON.stringify(invokedTranscript)});`);
    const adapter = new ClaudeCodeAdapter({ binary: stub.path });

    const outcome = await adapter.runPrompt({ prompt: "hi", packDir: packWith("haiku-writer") });

    expect(outcome.invokedSkills).toEqual(["haiku-writer"]);
    expect(outcome.usable).toBe(true);
  });

  it("installs the pack into a throwaway workspace, never the user's project", async () => {
    const stub = stubCli(`process.stdout.write(${JSON.stringify(invokedTranscript)});`);
    const packDir = packWith("haiku-writer");
    const adapter = new ClaudeCodeAdapter({ binary: stub.path });

    await adapter.runPrompt({ prompt: "hi", packDir });

    const log = JSON.parse(readFileSync(stub.logPath, "utf8")) as { cwd: string; visibleSkills: string[] };
    expect(log.cwd).not.toBe(process.cwd());
    expect(log.visibleSkills).toEqual(["haiku-writer"]);
    expect(existsSync(log.cwd)).toBe(false);
  });

  it("keeps the corpus out of the agent's workspace", async () => {
    const packDir = packWith("haiku-writer");
    mkdirSync(join(packDir, "haiku-writer", "evals"), { recursive: true });
    writeFileSync(join(packDir, "haiku-writer", "evals", "triggers.yaml"), 'skill: haiku-writer\n');
    const stub = stubCli(`process.stdout.write(${JSON.stringify(invokedTranscript)});`);

    await new ClaudeCodeAdapter({ binary: stub.path }).runPrompt({ prompt: "hi", packDir });

    const log = JSON.parse(readFileSync(stub.logPath, "utf8")) as { skillContents: string[] };
    expect(log.skillContents).toContain("SKILL.md");
    expect(log.skillContents).not.toContain("evals");
  });

  it("asks for machine-readable output and caps the conversation at one turn", async () => {
    const stub = stubCli(`process.stdout.write(${JSON.stringify(invokedTranscript)});`);
    const adapter = new ClaudeCodeAdapter({ binary: stub.path });

    await adapter.runPrompt({ prompt: "hi", packDir: packWith("s"), model: "claude-haiku-4-5-20251001" });

    const { argv } = JSON.parse(readFileSync(stub.logPath, "utf8")) as { argv: string[] };
    expect(argv).toContain("--print");
    expect(argv).toEqual(expect.arrayContaining(["--output-format", "stream-json"]));
    expect(argv).toEqual(expect.arrayContaining(["--max-turns", "1"]));
    expect(argv).toEqual(expect.arrayContaining(["--model", "claude-haiku-4-5-20251001"]));
  });

  it("forbids every tool except Skill, so a skill's instructions can never execute", async () => {
    const stub = stubCli(`process.stdout.write(${JSON.stringify(invokedTranscript)});`);
    const adapter = new ClaudeCodeAdapter({ binary: stub.path });

    await adapter.runPrompt({ prompt: "hi", packDir: packWith("s") });

    const { argv } = JSON.parse(readFileSync(stub.logPath, "utf8")) as { argv: string[] };
    const disallowed = (argv[argv.indexOf("--disallowed-tools") + 1] ?? "").split(",");
    expect(disallowed).toEqual([...DISALLOWED_TOOLS]);
    for (const tool of [
      "Bash", "Write", "Edit", "Read", "Task", "WebFetch", "WebSearch",
      "Artifact", "SendMessage", "CronCreate", "ScheduleWakeup", "ToolSearch", "Workflow",
    ]) {
      expect(disallowed).toContain(tool);
    }
    expect(disallowed).not.toContain("Skill");
    expect(argv).not.toContain("--dangerously-skip-permissions");
  });

  it("loads project settings only, so the user's own skills cannot answer", async () => {
    const stub = stubCli(`process.stdout.write(${JSON.stringify(invokedTranscript)});`);
    const adapter = new ClaudeCodeAdapter({ binary: stub.path });

    await adapter.runPrompt({ prompt: "hi", packDir: packWith("s") });

    const { argv } = JSON.parse(readFileSync(stub.logPath, "utf8")) as { argv: string[] };
    expect(argv).toEqual(expect.arrayContaining(["--setting-sources", "project"]));
  });

  it("marks a crashed CLI as unusable rather than a missed trigger", async () => {
    const stub = stubCli(`process.stderr.write("boom"); process.exit(3);`);
    const adapter = new ClaudeCodeAdapter({ binary: stub.path });

    const outcome = await adapter.runPrompt({ prompt: "hi", packDir: packWith("s") });

    expect(outcome.usable).toBe(false);
    expect(outcome.unusableReason).toMatch(/boom|exit/i);
  });

  it("treats the max-turns stop as a valid measurement", async () => {
    const stub = stubCli(`process.stdout.write(${JSON.stringify(invokedTranscript)}); process.exit(1);`);
    const adapter = new ClaudeCodeAdapter({ binary: stub.path });

    const outcome = await adapter.runPrompt({ prompt: "hi", packDir: packWith("haiku-writer") });

    expect(outcome.usable).toBe(true);
    expect(outcome.invokedSkills).toEqual(["haiku-writer"]);
  });

  it("removes the isolated config directory it creates", async () => {
    const stub = stubCli(`process.stdout.write(${JSON.stringify(invokedTranscript)});`);
    const adapter = new ClaudeCodeAdapter({ binary: stub.path, isolateConfigDir: true });

    await adapter.runPrompt({ prompt: "hi", packDir: packWith("s") });

    const log = JSON.parse(readFileSync(stub.logPath, "utf8")) as { configDir: string | null };
    expect(log.configDir).not.toBeNull();
    expect(existsSync(log.configDir as string)).toBe(false);
  });

  it("reports skills the agent could see that are not in the pack as contamination", async () => {
    const stub = stubCli(`process.stdout.write(${JSON.stringify(invokedTranscript)});`);
    const outcome = await new ClaudeCodeAdapter({ binary: stub.path }).runPrompt({
      prompt: "hi",
      packDir: packWith("haiku-writer"),
    });

    expect(outcome.foreignSkills).toEqual(["code-review", "debug"]);
    expect(outcome.invokedSkills).toEqual(["haiku-writer"]);
  });

  it("kills a hung CLI and reports the timeout", async () => {
    const stub = stubCli(`setTimeout(() => {}, 60000);`);
    const adapter = new ClaudeCodeAdapter({ binary: stub.path });

    const outcome = await adapter.runPrompt({ prompt: "hi", packDir: packWith("s"), timeoutMs: 300 });

    expect(outcome.usable).toBe(false);
    expect(outcome.unusableReason).toMatch(/timed out/i);
  });
});
