import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AntigravityAdapter } from "../../src/adapters/antigravity.js";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code.js";
import { CodexAdapter } from "../../src/adapters/codex.js";
import { CursorAdapter } from "../../src/adapters/cursor.js";
import { FakeAdapter } from "../../src/adapters/fake.js";

function stub(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "skillcaller-version-")), "cli");
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const echoArgs = stub(`process.stdout.write("cli " + process.argv.slice(2).join(" ") + "\\n");`);

describe("agent versions", () => {
  it.each([
    ["claude-code", new ClaudeCodeAdapter({ binary: echoArgs })],
    ["codex", new CodexAdapter({ binary: echoArgs })],
    ["cursor", new CursorAdapter({ binary: echoArgs })],
    ["antigravity", new AntigravityAdapter({ binary: echoArgs })],
  ])("%s reports its CLI's --version output", async (_name, adapter) => {
    await expect(adapter.version()).resolves.toBe("cli --version");
  });

  it("rejects when the CLI cannot report a version", async () => {
    const failing = new ClaudeCodeAdapter({ binary: stub(`process.stderr.write("boom"); process.exit(2);`) });

    await expect(failing.version()).rejects.toThrow(/boom/);
  });

  it("gives a fake agent a different version when its script changes", async () => {
    const before = await new FakeAdapter({ p: [["alpha"]] }).version();
    const after = await new FakeAdapter({ p: [[]] }).version();

    expect(after).not.toBe(before);
  });
});
