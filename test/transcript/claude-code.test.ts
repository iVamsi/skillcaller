import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseClaudeCodeTranscript } from "../../src/transcript/claude-code.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../../fixtures/claude-code/${name}`, import.meta.url), "utf8");

describe("parseClaudeCodeTranscript", () => {
  it("finds the skill invocation in a real recorded transcript", () => {
    // Recorded from `claude -p --output-format stream-json`, not hand-written.
    const result = parseClaudeCodeTranscript(fixture("invoked.ndjson"));

    expect(result.invokedSkills).toEqual(["haiku-writer"]);
    expect(result.usable).toBe(true);
  });

  it("reports a run where the model answered without any skill", () => {
    const result = parseClaudeCodeTranscript(fixture("not-logged-in.ndjson"));

    expect(result.invokedSkills).toEqual([]);
  });

  it("flags an unauthenticated run as unusable so it is never scored as a miss", () => {
    // "Not logged in" looks identical to a genuine non-trigger
    const result = parseClaudeCodeTranscript(fixture("not-logged-in.ndjson"));

    expect(result.usable).toBe(false);
    expect(result.unusableReason).toMatch(/not logged in/i);
  });

  it("reports cost so runs can be budgeted", () => {
    expect(parseClaudeCodeTranscript(fixture("invoked.ndjson")).costUsd).toBeGreaterThan(0);
  });

  it("records every distinct skill once, in invocation order", () => {
    const ndjson = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "b" } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "a" } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "b" } }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ].join("\n");

    expect(parseClaudeCodeTranscript(ndjson).invokedSkills).toEqual(["b", "a"]);
  });

  it("ignores non-Skill tool calls", () => {
    const ndjson = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/x" } }] },
    });

    expect(parseClaudeCodeTranscript(ndjson).invokedSkills).toEqual([]);
  });

  it("skips malformed lines instead of failing the whole run", () => {
    const ndjson = [
      "not json at all",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "a" } }] } }),
      "",
    ].join("\n");

    expect(parseClaudeCodeTranscript(ndjson).invokedSkills).toEqual(["a"]);
  });

  it("treats a transcript with no result event as unusable", () => {
    // A killed or truncated process must not be scored.
    const result = parseClaudeCodeTranscript("");

    expect(result.usable).toBe(false);
    expect(result.unusableReason).toMatch(/no result/i);
  });

  it("exposes the skills the agent could see, for contamination checks", () => {
    const result = parseClaudeCodeTranscript(fixture("not-logged-in.ndjson"));

    expect(result.visibleSkills).toContain("haiku-writer");
  });
});
