import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CursorAdapter } from "../../src/adapters/cursor.js";

function stubCli(body: string): { path: string; logPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "skillcaller-cursor-stub-"));
  const logPath = join(dir, "invocation.json");
  const path = join(dir, "cursor-agent");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const { writeFileSync, existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const wsIndex = argv.indexOf("--workspace");
const workspace = wsIndex === -1 ? process.cwd() : argv[wsIndex + 1];
const skillsDir = join(workspace, ".cursor", "skills");
writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  argv,
  workspace,
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

function packWith(skillName: string): string {
  const packDir = mkdtempSync(join(tmpdir(), "skillcaller-cursor-pack-"));
  mkdirSync(join(packDir, skillName), { recursive: true });
  writeFileSync(join(packDir, skillName, "SKILL.md"), `---\nname: ${skillName}\ndescription: d\n---\n`);
  return packDir;
}

describe("CursorAdapter", () => {
  it("detects the skill Cursor read from the pack", async () => {
    const stub = stubCli(`
const skillFile = join(workspace, ".cursor", "skills", "haiku-writer", "SKILL.md");
process.stdout.write([
  JSON.stringify({ type: "tool_call", subtype: "completed", tool_call: { readToolCall: { args: { path: skillFile } } } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false }),
].join("\\n"));
`);
    const outcome = await new CursorAdapter({ binary: stub.path }).runPrompt({
      prompt: "hi",
      packDir: packWith("haiku-writer"),
    });

    expect(outcome.invokedSkills).toEqual(["haiku-writer"]);
    expect(outcome.usable).toBe(true);
  });

  it("runs in a throwaway workspace in read-only mode holding only the pack", async () => {
    const stub = stubCli(`process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false }));`);
    await new CursorAdapter({ binary: stub.path }).runPrompt({ prompt: "hi", packDir: packWith("alpha") });

    const log = JSON.parse(readFileSync(stub.logPath, "utf8")) as {
      argv: string[]; visibleSkills: string[]; workspace: string;
    };
    expect(log.visibleSkills).toEqual(["alpha"]);
    expect(log.argv).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--trust", "--mode", "ask"]));
    expect(existsSync(log.workspace)).toBe(false);
  });

  it("keeps the corpus out of the sandbox", async () => {
    const packDir = packWith("alpha");
    mkdirSync(join(packDir, "alpha", "evals"), { recursive: true });
    writeFileSync(join(packDir, "alpha", "evals", "triggers.yaml"), "skill: alpha\n");
    const stub = stubCli(`process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false }));`);

    await new CursorAdapter({ binary: stub.path }).runPrompt({ prompt: "hi", packDir });

    const log = JSON.parse(readFileSync(stub.logPath, "utf8")) as { skillContents: string[] };
    expect(log.skillContents).toContain("SKILL.md");
    expect(log.skillContents).not.toContain("evals");
  });

  it("passes the model through", async () => {
    const stub = stubCli(`process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false }));`);
    await new CursorAdapter({ binary: stub.path }).runPrompt({
      prompt: "hi", packDir: packWith("a"), model: "claude-3.5-sonnet",
    });

    const { argv } = JSON.parse(readFileSync(stub.logPath, "utf8")) as { argv: string[] };
    expect(argv).toEqual(expect.arrayContaining(["--model", "claude-3.5-sonnet"]));
  });

  it("marks a crashed CLI as unusable", async () => {
    const stub = stubCli(`process.stderr.write("cursor boom"); process.exit(2);`);
    const outcome = await new CursorAdapter({ binary: stub.path }).runPrompt({ prompt: "hi", packDir: packWith("a") });

    expect(outcome.usable).toBe(false);
    expect(outcome.unusableReason).toMatch(/boom|exit/i);
  });

  it("kills a hung CLI and reports the timeout", async () => {
    const stub = stubCli(`setTimeout(() => {}, 60000);`);
    const adapter = new CursorAdapter({ binary: stub.path });

    const outcome = await adapter.runPrompt({ prompt: "hi", packDir: packWith("s"), timeoutMs: 300 });

    expect(outcome.usable).toBe(false);
    expect(outcome.unusableReason).toMatch(/timed out/i);
  });
});
