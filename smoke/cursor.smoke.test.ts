import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CursorAdapter } from "../src/adapters/cursor.js";

const live = process.env["LIVE"] === "1";

function cursorInstalled(): boolean {
  try {
    execFileSync("cursor-agent", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function haikuPack(): string {
  const packDir = mkdtempSync(join(tmpdir(), "skillcaller-cursor-smoke-"));
  mkdirSync(join(packDir, "haiku-writer"), { recursive: true });
  writeFileSync(
    join(packDir, "haiku-writer", "SKILL.md"),
    `---
name: haiku-writer
description: Use when the user asks to write a haiku or any short Japanese-form poem. Triggers on "write a haiku", "compose a haiku", "5-7-5 poem".
---

# Haiku writer

Write a haiku with 5-7-5 syllables. Output only the poem.
`,
  );
  return packDir;
}

describe.skipIf(!live || !cursorInstalled())("CursorAdapter (live)", () => {
  it("detects a real skill invocation from the real cursor-agent CLI", async () => {
    const outcome = await new CursorAdapter().runPrompt({
      prompt: "write a haiku about gradle builds",
      packDir: haikuPack(),
      timeoutMs: 170_000,
    });

    expect(outcome.usable).toBe(true);
    expect(outcome.invokedSkills).toContain("haiku-writer");
  });
});
