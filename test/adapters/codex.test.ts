import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../../src/adapters/codex.js";

function stubCli(body: string): { path: string; logPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "skillcaller-codex-stub-"));
  const logPath = join(dir, "invocation.json");
  const path = join(dir, "codex");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const { writeFileSync, existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const cdIndex = argv.indexOf("-C");
const workspace = cdIndex === -1 ? process.cwd() : argv[cdIndex + 1];
const skillsDir = join(workspace, ".codex", "skills");
writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  argv,
  workspace,
  visibleSkills: existsSync(skillsDir) ? readdirSync(skillsDir) : [],
  skillContents: existsSync(skillsDir) ? readdirSync(skillsDir).flatMap((s) => readdirSync(join(skillsDir, s))) : [],
  isGitRepo: existsSync(join(workspace, ".git")),
}));
${body}
`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return { path, logPath };
}

function packWith(skillName: string): string {
  const packDir = mkdtempSync(join(tmpdir(), "skillcaller-codex-pack-"));
  mkdirSync(join(packDir, skillName), { recursive: true });
  writeFileSync(join(packDir, skillName, "SKILL.md"), `---\nname: ${skillName}\ndescription: d\n---\n`);
  return packDir;
}

describe("CodexAdapter", () => {
  it("detects the skill Codex read from the pack", async () => {
    const stub = stubCli(`
const skillFile = join(workspace, ".codex", "skills", "haiku-writer", "SKILL.md");
process.stdout.write([
  JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "sed -n '1,10p' '" + skillFile + "'" } }),
  JSON.stringify({ type: "turn.completed" }),
].join("\\n"));
`);
    const outcome = await new CodexAdapter({ binary: stub.path }).runPrompt({
      prompt: "hi",
      packDir: packWith("haiku-writer"),
    });

    expect(outcome.invokedSkills).toEqual(["haiku-writer"]);
    expect(outcome.usable).toBe(true);
  });

  it("runs read-only in a throwaway git workspace holding only the pack", async () => {
    const stub = stubCli(`process.stdout.write(${JSON.stringify(JSON.stringify({ type: "turn.completed" }))});`);
    await new CodexAdapter({ binary: stub.path }).runPrompt({ prompt: "hi", packDir: packWith("alpha") });

    const log = JSON.parse(readFileSync(stub.logPath, "utf8")) as {
      argv: string[]; visibleSkills: string[]; isGitRepo: boolean; workspace: string;
    };
    expect(log.visibleSkills).toEqual(["alpha"]);
    expect(log.argv).toEqual(expect.arrayContaining(["--json", "--sandbox", "read-only"]));
    // Codex refuses to run outside a trusted directory unless told otherwise.
    expect(log.argv.includes("--skip-git-repo-check") || log.isGitRepo).toBe(true);
    expect(log.argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(existsSync(log.workspace)).toBe(false);
  });

  it("uses a canonical workspace path so symlinked temp dirs still match", async () => {
    // On macOS /var is a symlink to /private/var
    const stub = stubCli(`
const skillFile = join(workspace, ".codex", "skills", "alpha", "SKILL.md");
process.stdout.write([
  JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "sed -n '1,5p' '" + require("node:fs").realpathSync(workspace) + "/.codex/skills/alpha/SKILL.md'" } }),
  JSON.stringify({ type: "turn.completed" }),
].join("\\n"));
`);
    const outcome = await new CodexAdapter({ binary: stub.path }).runPrompt({
      prompt: "hi",
      packDir: packWith("alpha"),
    });

    expect(outcome.invokedSkills).toEqual(["alpha"]);
  });

  it("keeps the corpus out of the sandbox", async () => {
    const packDir = packWith("alpha");
    mkdirSync(join(packDir, "alpha", "evals"), { recursive: true });
    writeFileSync(join(packDir, "alpha", "evals", "triggers.yaml"), "skill: alpha\n");
    const stub = stubCli(`process.stdout.write(${JSON.stringify(JSON.stringify({ type: "turn.completed" }))});`);

    await new CodexAdapter({ binary: stub.path }).runPrompt({ prompt: "hi", packDir });

    const log = JSON.parse(readFileSync(stub.logPath, "utf8")) as { skillContents: string[] };
    expect(log.skillContents).toContain("SKILL.md");
    expect(log.skillContents).not.toContain("evals");
  });

  it("passes the model through", async () => {
    const stub = stubCli(`process.stdout.write(${JSON.stringify(JSON.stringify({ type: "turn.completed" }))});`);
    await new CodexAdapter({ binary: stub.path }).runPrompt({
      prompt: "hi", packDir: packWith("a"), model: "gpt-5",
    });

    const { argv } = JSON.parse(readFileSync(stub.logPath, "utf8")) as { argv: string[] };
    expect(argv).toEqual(expect.arrayContaining(["--model", "gpt-5"]));
  });

  it("marks a crashed CLI unusable", async () => {
    const stub = stubCli(`process.stderr.write("codex boom"); process.exit(2);`);
    const outcome = await new CodexAdapter({ binary: stub.path }).runPrompt({ prompt: "hi", packDir: packWith("a") });

    expect(outcome.usable).toBe(false);
    expect(outcome.unusableReason).toMatch(/boom|exit/i);
  });
});
