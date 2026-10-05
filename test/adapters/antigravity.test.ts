import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
    log.installCount = (log.installCount ?? 0) + 1;
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
    log.uninstallCount = (log.uninstallCount ?? 0) + 1;
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

/** Keeps ownership records out of the real journal, which a later real run would act on. */
const tempJournal = () => mkdtempSync(join(tmpdir(), "skillcaller-agy-journal-"));

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
    const outcome = await new AntigravityAdapter({ binary: stub.path, journalDir: tempJournal() }).runPrompt({
      prompt: "hi",
      packDir: packWith("haiku-writer"),
    });

    expect(outcome.invokedSkills).toEqual(["haiku-writer"]);
    expect(outcome.usable).toBe(true);
  });

  it("installs a plugin, runs sandboxed print mode, and removes the workspace", async () => {
    const stub = stubCli(`process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }));`);
    const adapter = new AntigravityAdapter({ binary: stub.path, journalDir: tempJournal() });
    await adapter.runPrompt({ prompt: "hi", packDir: packWith("alpha") });

    const during = JSON.parse(readFileSync(stub.logPath, "utf8")) as {
      installArgv: string[];
      uninstallArgv?: string[];
      printArgv: string[];
      visibleSkills: string[];
      name: string;
      printCwd: string;
    };
    expect(during.visibleSkills).toEqual(["alpha"]);
    expect(during.installArgv[0]).toBe("plugin");
    expect(during.installArgv[1]).toBe("install");
    expect(during.uninstallArgv).toBeUndefined();
    expect(during.printArgv).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--sandbox"]));
    expect(during.printArgv[during.printArgv.indexOf("-p") + 1]).toBe("hi");
    expect(during.printArgv).not.toContain("--dangerously-skip-permissions");
    expect(existsSync(during.printCwd)).toBe(false);

    await adapter.close();
    const after = JSON.parse(readFileSync(stub.logPath, "utf8")) as { uninstallArgv: string[]; name: string };
    expect(after.uninstallArgv).toEqual(["plugin", "uninstall", after.name]);
  });

  it("keeps the corpus out of the plugin", async () => {
    const packDir = packWith("alpha");
    mkdirSync(join(packDir, "alpha", "evals"), { recursive: true });
    writeFileSync(join(packDir, "alpha", "evals", "triggers.yaml"), "skill: alpha\n");
    const stub = stubCli(`process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }));`);

    await new AntigravityAdapter({ binary: stub.path, journalDir: tempJournal() }).runPrompt({ prompt: "hi", packDir });

    const log = JSON.parse(readFileSync(stub.logPath, "utf8")) as { skillContents: string[] };
    expect(log.skillContents).toContain("SKILL.md");
    expect(log.skillContents).not.toContain("evals");
  });

  it("passes the model through", async () => {
    const stub = stubCli(`process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }));`);
    await new AntigravityAdapter({ binary: stub.path, journalDir: tempJournal() }).runPrompt({
      prompt: "hi", packDir: packWith("a"), model: "gemini-3.5-flash-low",
    });

    const { printArgv } = JSON.parse(readFileSync(stub.logPath, "utf8")) as { printArgv: string[] };
    expect(printArgv).toEqual(expect.arrayContaining(["--model", "gemini-3.5-flash-low"]));
  });

  it("marks a crashed CLI as unusable", async () => {
    const stub = stubCli(`process.stderr.write("agy boom"); process.exit(2);`);
    const outcome = await new AntigravityAdapter({ binary: stub.path, journalDir: tempJournal() }).runPrompt({ prompt: "hi", packDir: packWith("a") });

    expect(outcome.usable).toBe(false);
    expect(outcome.unusableReason).toMatch(/boom|exit/i);
  });

  it("installs the plugin once for a pack and uninstalls on close", async () => {
    const stub = stubCli(`process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }));`);
    const adapter = new AntigravityAdapter({ binary: stub.path, journalDir: tempJournal() });
    const packDir = packWith("alpha");

    await adapter.runPrompt({ prompt: "hi", packDir });
    await adapter.runPrompt({ prompt: "again", packDir });

    const during = JSON.parse(readFileSync(stub.logPath, "utf8")) as { installCount: number; uninstallCount?: number };
    expect(during.installCount).toBe(1);
    expect(during.uninstallCount ?? 0).toBe(0);

    await adapter.close();

    const after = JSON.parse(readFileSync(stub.logPath, "utf8")) as { uninstallCount: number; uninstallArgv: string[]; name: string };
    expect(after.uninstallCount).toBe(1);
    expect(after.uninstallArgv).toEqual(["plugin", "uninstall", after.name]);
  });

  it("kills a hung CLI and reports the timeout", async () => {
    const stub = stubCli(`setTimeout(() => {}, 60000);`);
    const adapter = new AntigravityAdapter({ binary: stub.path, journalDir: tempJournal() });

    try {
      const outcome = await adapter.runPrompt({ prompt: "hi", packDir: packWith("s"), timeoutMs: 300 });

      expect(outcome.usable).toBe(false);
      expect(outcome.unusableReason).toMatch(/timed out/i);
    } finally {
      await adapter.close();
    }
  });
});

/** An agy stand-in whose plugin commands create and remove `<root>/<name>`, optionally failing. */
function pluginCli(root: string, behavior: { install?: "ok" | "partial"; uninstall?: "ok" | "fail" } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "skillcaller-agy-plugins-"));
  const path = join(dir, "agy");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const { mkdirSync, readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const root = ${JSON.stringify(root)};
if (argv[0] === "plugin" && argv[1] === "install") {
  const name = JSON.parse(readFileSync(join(argv[2], "plugin.json"), "utf8")).name;
  mkdirSync(join(root, name), { recursive: true });
  if (${JSON.stringify(behavior.install ?? "ok")} === "partial") { process.stderr.write("disk full"); process.exit(1); }
  process.exit(0);
}
if (argv[0] === "plugin" && argv[1] === "uninstall") {
  if (${JSON.stringify(behavior.uninstall ?? "ok")} === "fail") { process.stderr.write("locked"); process.exit(1); }
  rmSync(join(root, argv[2]), { recursive: true, force: true });
  process.exit(0);
}
process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }));
`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return path;
}

function ownership() {
  const pluginsRoot = mkdtempSync(join(tmpdir(), "skillcaller-agy-root-"));
  const journalDir = mkdtempSync(join(tmpdir(), "skillcaller-agy-journal-"));
  return { pluginsRoot, journalDir, installed: () => readdirSync(pluginsRoot), records: () => readdirSync(journalDir) };
}

describe("AntigravityAdapter plugin ownership", () => {
  it("records the plugin before installing and clears the record once uninstall is confirmed", async () => {
    const owned = ownership();
    const adapter = new AntigravityAdapter({ binary: pluginCli(owned.pluginsRoot), ...owned });

    await adapter.runPrompt({ prompt: "hi", packDir: packWith("a") });
    expect(owned.records()).toHaveLength(1);
    expect(owned.installed()).toHaveLength(1);

    await adapter.close();
    expect(owned.records()).toEqual([]);
    expect(owned.installed()).toEqual([]);
  });

  it("fails close with the exact plugin name and keeps the record when uninstall fails", async () => {
    const owned = ownership();
    const failing = new AntigravityAdapter({ binary: pluginCli(owned.pluginsRoot, { uninstall: "fail" }), ...owned });
    await failing.runPrompt({ prompt: "hi", packDir: packWith("a") });
    const name = owned.installed()[0] as string;

    await expect(failing.close()).rejects.toThrow(new RegExp(`agy plugin uninstall ${name}`));
    expect(owned.records()).toHaveLength(1);
  });

  it("is safe to close twice", async () => {
    const owned = ownership();
    const adapter = new AntigravityAdapter({ binary: pluginCli(owned.pluginsRoot), ...owned });
    await adapter.runPrompt({ prompt: "hi", packDir: packWith("a") });

    await adapter.close();
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  it("removes a partly installed plugin when install fails", async () => {
    const owned = ownership();
    const adapter = new AntigravityAdapter({ binary: pluginCli(owned.pluginsRoot, { install: "partial" }), ...owned });

    const outcome = await adapter.runPrompt({ prompt: "hi", packDir: packWith("a") });

    expect(outcome.usable).toBe(false);
    expect(outcome.unusableReason).toMatch(/disk full/);
    expect(owned.installed()).toEqual([]);
    expect(owned.records()).toEqual([]);
  });

  it("recovers a plugin left behind by a run that was killed", async () => {
    const owned = ownership();
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    mkdirSync(join(owned.pluginsRoot, "scdeadbeef"));
    writeFileSync(
      join(owned.journalDir, "scdeadbeef.json"),
      JSON.stringify({ pluginName: "scdeadbeef", pluginDir: join(tmpdir(), "gone"), pid: deadPid }),
    );
    const adapter = new AntigravityAdapter({ binary: pluginCli(owned.pluginsRoot), ...owned });

    await adapter.runPrompt({ prompt: "hi", packDir: packWith("a") });

    expect(owned.installed()).not.toContain("scdeadbeef");
    expect(owned.records()).not.toContain("scdeadbeef.json");
    await adapter.close();
  });

  it("leaves a plugin owned by a run that is still alive", async () => {
    const owned = ownership();
    mkdirSync(join(owned.pluginsRoot, "sclive"));
    writeFileSync(
      join(owned.journalDir, "sclive.json"),
      JSON.stringify({ pluginName: "sclive", pluginDir: join(tmpdir(), "gone"), pid: process.ppid }),
    );
    const adapter = new AntigravityAdapter({ binary: pluginCli(owned.pluginsRoot), ...owned });

    await adapter.runPrompt({ prompt: "hi", packDir: packWith("a") });
    await adapter.close();

    expect(owned.installed()).toEqual(["sclive"]);
    expect(owned.records()).toEqual(["sclive.json"]);
  });
});
