import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";

/** Real `claude` CLI; spends tokens. `npm run smoke`, not `npm test`. */
const live = process.env["LIVE"] === "1";

function haikuPack(): string {
  const packDir = mkdtempSync(join(tmpdir(), "skillcaller-smoke-pack-"));
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

describe.skipIf(!live)("ClaudeCodeAdapter (live)", () => {
  it("detects a real skill invocation from the real CLI", async () => {
    const outcome = await new ClaudeCodeAdapter().runPrompt({
      prompt: "write a haiku about gradle builds",
      packDir: haikuPack(),
      model: "claude-haiku-4-5-20251001",
      timeoutMs: 150_000,
    });

    expect(outcome.usable).toBe(true);
    expect(outcome.invokedSkills).toContain("haiku-writer");
    expect(outcome.costUsd).toBeGreaterThan(0);
    console.log(`live run cost: $${outcome.costUsd.toFixed(4)}`);
  });

  it("does not expose the user's own installed skills to the run", async () => {
    const outcome = await new ClaudeCodeAdapter().runPrompt({
      prompt: "use your brainstorming skill to plan a birthday party",
      packDir: haikuPack(),
      model: "claude-haiku-4-5-20251001",
      timeoutMs: 150_000,
    });

    expect(outcome.invokedSkills.filter((s) => s !== "haiku-writer")).toEqual([]);
  });
});
