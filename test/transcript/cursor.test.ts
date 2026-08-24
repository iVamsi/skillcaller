import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCursorTranscript } from "../../src/transcript/cursor.js";

const fixture = readFileSync(new URL("../../fixtures/cursor/invoked.ndjson", import.meta.url), "utf8");

describe("parseCursorTranscript", () => {
  it("detects the skill from readToolCall on SKILL.md", () => {
    const result = parseCursorTranscript(fixture, "/workspace/.cursor/skills");

    expect(result.invokedSkills).toEqual(["haiku-writer"]);
    expect(result.foreignSkills).toEqual([]);
    expect(result.usable).toBe(true);
  });

  it("reports skills read from outside the pack as contamination", () => {
    const ndjson = [
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        tool_call: { readToolCall: { args: { path: "/home/user/.agents/skills/personal/SKILL.md" } } },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ].join("\n");

    const result = parseCursorTranscript(ndjson, "/workspace/.cursor/skills");

    expect(result.invokedSkills).toEqual([]);
    expect(result.foreignSkills).toEqual(["personal"]);
    expect(result.usable).toBe(true);
  });

  it("matches a pack path containing spaces", () => {
    const packDir = "/Users/First Last/pack/.cursor/skills";
    const ndjson = [
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        tool_call: { readToolCall: { args: { path: "/Users/First Last/pack/.cursor/skills/alpha/SKILL.md" } } },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ].join("\n");

    const result = parseCursorTranscript(ndjson, packDir);

    expect(result.invokedSkills).toEqual(["alpha"]);
    expect(result.foreignSkills).toEqual([]);
  });

  it("ignores non-SKILL.md tool calls", () => {
    const ndjson = [
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        tool_call: { readToolCall: { args: { path: "/workspace/src/index.ts" } } },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ].join("\n");

    const result = parseCursorTranscript(ndjson, "/workspace");

    expect(result.invokedSkills).toEqual([]);
    expect(result.foreignSkills).toEqual([]);
  });

  it("deduplicates multiple reads of the same skill", () => {
    const ndjson = [
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        tool_call: { readToolCall: { args: { path: "/workspace/alpha/SKILL.md" } } },
      }),
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        tool_call: { readToolCall: { args: { path: "/workspace/alpha/SKILL.md" } } },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ].join("\n");

    const result = parseCursorTranscript(ndjson, "/workspace");

    expect(result.invokedSkills).toEqual(["alpha"]);
  });

  it("marks a transcript with no result event as unusable", () => {
    expect(parseCursorTranscript("", "/workspace").usable).toBe(false);
  });

  it("marks an error result as unusable", () => {
    const ndjson = JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "agent crashed" });

    const result = parseCursorTranscript(ndjson, "/workspace");

    expect(result.usable).toBe(false);
    expect(result.unusableReason).toMatch(/crashed/);
  });

  it("detects unauthenticated runs", () => {
    const ndjson = JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "Not logged in" });

    const result = parseCursorTranscript(ndjson, "/workspace");

    expect(result.usable).toBe(false);
    expect(result.unusableReason).toMatch(/not logged in/i);
  });

  it("skips malformed JSON lines", () => {
    const ndjson = ["not json", fixture].join("\n");

    const result = parseCursorTranscript(ndjson, "/workspace/.cursor/skills");

    expect(result.invokedSkills).toEqual(["haiku-writer"]);
    expect(result.usable).toBe(true);
  });
});
