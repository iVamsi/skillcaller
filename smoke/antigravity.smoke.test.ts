import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AntigravityAdapter } from "../src/adapters/antigravity.js";

const live = process.env["LIVE"] === "1";

function agyInstalled(): boolean {
  try {
    execFileSync("agy", ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function haikuPack(): string {
  const packDir = mkdtempSync(join(tmpdir(), "skillcaller-agy-smoke-"));
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

describe.skipIf(!live || !agyInstalled())("AntigravityAdapter (live)", () => {
  it("detects a real skill invocation from the real agy CLI", async () => {
    const adapter = new AntigravityAdapter();
    try {
      const outcome = await adapter.runPrompt({
        prompt: "write a haiku about gradle builds",
        packDir: haikuPack(),
        model: "gemini-3.5-flash-low",
        timeoutMs: 170_000,
      });

      expect(outcome.usable, outcome.unusableReason).toBe(true);
      const seen = [...outcome.invokedSkills, ...(outcome.foreignSkills ?? [])];
      expect(seen).toContain("haiku-writer");
    } finally {
      await adapter.close();
    }
  });
});
