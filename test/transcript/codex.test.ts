import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCodexTranscript } from "../../src/transcript/codex.js";

const fixture = readFileSync(new URL("../../fixtures/codex/invoked.jsonl", import.meta.url), "utf8");

describe("parseCodexTranscript", () => {
  it("detects the skill from the SKILL.md file the agent read", () => {
    // Codex has no Skill tool: it opens the skill file with a shell command
    const result = parseCodexTranscript(fixture, "/tmp/workspace/.codex/skills");

    expect(result.invokedSkills).toEqual(["haiku-writer"]);
    expect(result.usable).toBe(true);
  });

  it("reports skills read from outside the pack as contamination, not as hits", () => {
    // The same recording shows Codex reading a personal skill from ~/.agents/skills.
    const result = parseCodexTranscript(fixture, "/tmp/workspace/.codex/skills");

    expect(result.invokedSkills).not.toContain("writing-google-eli5");
    expect(result.foreignSkills).toEqual(["writing-google-eli5"]);
  });

  it("matches a pack path containing spaces", () => {
    // "/Users/First Last" truncated the parent at the space, so a genuine hit looked foreign
    const packDir = "/Users/First Last/pack/.codex/skills";
    const jsonl = [
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: `sed -n '1,10p' '/Users/First Last/pack/.codex/skills/alpha/SKILL.md'` },
      }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");

    const result = parseCodexTranscript(jsonl, packDir);

    expect(result.invokedSkills).toEqual(["alpha"]);
    expect(result.foreignSkills).toEqual([]);
  });

  it("still reports a foreign skill when the pack path contains spaces", () => {
    const jsonl = [
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: `sed -n '1,10p' '/home/user/.agents/skills/intruder/SKILL.md'` },
      }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");

    const result = parseCodexTranscript(jsonl, "/Users/First Last/pack/.codex/skills");

    expect(result.invokedSkills).toEqual([]);
    expect(result.foreignSkills).toEqual(["intruder"]);
  });

  it("treats a transcript with no completed turn as unusable", () => {
    expect(parseCodexTranscript("", "/pack").usable).toBe(false);
  });

  it("ignores shell commands that touch no skill file", () => {
    const jsonl = [
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "ls -la" } }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");

    expect(parseCodexTranscript(jsonl, "/pack").invokedSkills).toEqual([]);
  });

  it("counts a skill once however many times its file is read", () => {
    const read = (path: string) =>
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: `sed -n '1,10p' '${path}'` } });
    const jsonl = [
      read("/pack/alpha/SKILL.md"),
      read("/pack/alpha/SKILL.md"),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");

    expect(parseCodexTranscript(jsonl, "/pack").invokedSkills).toEqual(["alpha"]);
  });

  it("skips malformed lines", () => {
    const jsonl = ["}{", JSON.stringify({ type: "turn.completed" })].join("\n");

    expect(parseCodexTranscript(jsonl, "/pack").usable).toBe(true);
  });
});
