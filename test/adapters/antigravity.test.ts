import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AntigravityAdapter } from "../../src/adapters/antigravity.js";

function stubCli(body: string): { path: string; logPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "skillcaller-agy-stub-"));
  const logPath = join(dir, "invocation.json");
  const path = join(dir, "agy");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const { writeFileSync, existsSync, readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");
const argv = process.argv.slice(2);
const logPath = ${JSON.stringify(logPath)};
function readLog() {
  try { return JSON.parse(readFileSync(logPath, "utf8")); } catch { return {}; }
}
if (argv[0] === "plugin") {
  const log = readLog();
  if (argv[1] === "install") {
    const pluginDir = argv[2];
    const manifest = JSON.parse(readFileSync(join(pluginDir, "plugin.json"), "utf8"));
    const skillsDir = join(pluginDir, "skills");
    log.installArgv = argv;
    log.pluginDir = pluginDir;
    log.name = manifest.name;
    log.visibleSkills = existsSync(skillsDir) ? readdirSync(skillsDir) : [];
    log.skillContents = log.visibleSkills.flatMap((s) => readdirSync(join(skillsDir, s)));
    log.cwd = process.cwd();
    writeFileSync(logPath, JSON.stringify(log));
    process.exit(0);
  }
  if (argv[1] === "uninstall") {
    log.uninstallArgv = argv;
    writeFileSync(logPath, JSON.stringify(log));
    process.exit(0);
  }
}
const log = readLog();
log.printArgv = argv;
log.printCwd = process.cwd();
writeFileSync(logPath, JSON.stringify(log));
${body}
`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return { path, logPath };
}

function packWith(skillName: string): string {
  const packDir = mkdtempSync(join(tmpdir(), "skillcaller-agy-pack-"));
  mkdirSync(join(packDir, skillName), { recursive: true });
  writeFileSync(join(packDir, skillName, "SKILL.md"), `---\nname: ${skillName}\ndescription: d\n---\n`);
  return packDir;
}

describe("AntigravityAdapter", () => {
  it("detects the skill agy read from the installed plugin", async () => {
    const stub = stubCli(`
const skillFile = join(homedir(), ".gemini", "config", "plugins", log.name, "skills", "haiku-writer", "SKILL.md");
process.stdout.write([
  JSON.stringify({ event: "step_update", step_update: { step_type: "tool", tool_name: "view_file", tool_info: { parameters: { AbsolutePath: skillFile } } } }),
  JSON.stringify({ event: "result", result: { status: "SUCCESS" } }),
].join("\\n"));
`);
    const outcome = await new AntigravityAdapter({ binary: stub.path }).runPrompt({
      prompt: "hi",
      packDir: packWith("haiku-writer"),
    });

    expect(outcome.invokedSkills).toEqual(["haiku-writer"]);
    expect(outcome.usable).toBe(true);
  });

  it("installs a plugin, runs sandboxed print mode, and removes the workspace", async () => {
    const stub = stubCli(`process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }));`);
    await new AntigravityAdapter({ binary: stub.path }).runPrompt({ prompt: "hi", packDir: packWith("alpha") });

    const log = JSON.parse(readFileSync(stub.logPath, "utf8")) as {
      installArgv: string[];
      uninstallArgv: string[];
      printArgv: string[];
      visibleSkills: string[];
      name: string;
      printCwd: string;
    };
    expect(log.visibleSkills).toEqual(["alpha"]);
    expect(log.installArgv[0]).toBe("plugin");
    expect(log.installArgv[1]).toBe("install");
    expect(log.uninstallArgv).toEqual(["plugin", "uninstall", log.name]);
    expect(log.printArgv).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--sandbox"]));
    expect(log.printArgv[log.printArgv.indexOf("-p") + 1]).toBe("hi");
    expect(log.printArgv).not.toContain("--dangerously-skip-permissions");
    expect(existsSync(log.printCwd)).toBe(false);
  });

  it("keeps the corpus out of the plugin", async () => {
    const packDir = packWith("alpha");
    mkdirSync(join(packDir, "alpha", "evals"), { recursive: true });
    writeFileSync(join(packDir, "alpha", "evals", "triggers.yaml"), "skill: alpha\n");
    const stub = stubCli(`process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }));`);

    await new AntigravityAdapter({ binary: stub.path }).runPrompt({ prompt: "hi", packDir });

    const log = JSON.parse(readFileSync(stub.logPath, "utf8")) as { skillContents: string[] };
    expect(log.skillContents).toContain("SKILL.md");
    expect(log.skillContents).not.toContain("evals");
  });

  it("passes the model through", async () => {
    const stub = stubCli(`process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }));`);
    await new AntigravityAdapter({ binary: stub.path }).runPrompt({
      prompt: "hi", packDir: packWith("a"), model: "gemini-3.5-flash-low",
    });

    const { printArgv } = JSON.parse(readFileSync(stub.logPath, "utf8")) as { printArgv: string[] };
    expect(printArgv).toEqual(expect.arrayContaining(["--model", "gemini-3.5-flash-low"]));
  });

  it("marks a crashed CLI as unusable", async () => {
    const stub = stubCli(`process.stderr.write("agy boom"); process.exit(2);`);
    const outcome = await new AntigravityAdapter({ binary: stub.path }).runPrompt({ prompt: "hi", packDir: packWith("a") });

    expect(outcome.usable).toBe(false);
    expect(outcome.unusableReason).toMatch(/boom|exit/i);
  });

  it("kills a hung CLI and reports the timeout", async () => {
    const stub = stubCli(`setTimeout(() => {}, 60000);`);
    const adapter = new AntigravityAdapter({ binary: stub.path });

    const outcome = await adapter.runPrompt({ prompt: "hi", packDir: packWith("s"), timeoutMs: 300 });

    expect(outcome.usable).toBe(false);
    expect(outcome.unusableReason).toMatch(/timed out/i);
  });
});
