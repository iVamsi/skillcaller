import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAntigravityTranscript } from "../../src/transcript/antigravity.js";

const fixture = readFileSync(new URL("../../fixtures/antigravity/invoked.ndjson", import.meta.url), "utf8");

describe("parseAntigravityTranscript", () => {
  it("detects the skill from view_file on SKILL.md", () => {
    const result = parseAntigravityTranscript(fixture, "/workspace/plugins/skills");

    expect(result.invokedSkills).toEqual(["haiku-writer"]);
    expect(result.foreignSkills).toEqual([]);
    expect(result.usable).toBe(true);
  });

  it("reports skills read from outside the pack as contamination", () => {
    const ndjson = [
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "tool",
          tool_name: "view_file",
          tool_info: { parameters: { AbsolutePath: "/Users/me/.gemini/config/skills/personal/SKILL.md" } },
        },
      }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS" } }),
    ].join("\n");

    const result = parseAntigravityTranscript(ndjson, "/workspace/plugins/skills");

    expect(result.invokedSkills).toEqual([]);
    expect(result.foreignSkills).toEqual(["personal"]);
    expect(result.usable).toBe(true);
  });

  it("matches a pack path containing spaces", () => {
    const packDir = "/Users/First Last/plugins/skills";
    const ndjson = [
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "tool",
          tool_name: "view_file",
          tool_info: { parameters: { AbsolutePath: "/Users/First Last/plugins/skills/alpha/SKILL.md" } },
        },
      }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS" } }),
    ].join("\n");

    const result = parseAntigravityTranscript(ndjson, packDir);

    expect(result.invokedSkills).toEqual(["alpha"]);
    expect(result.foreignSkills).toEqual([]);
  });

  it("ignores non-SKILL.md tool calls", () => {
    const ndjson = [
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "tool",
          tool_name: "view_file",
          tool_info: { parameters: { AbsolutePath: "/workspace/src/index.ts" } },
        },
      }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS" } }),
    ].join("\n");

    const result = parseAntigravityTranscript(ndjson, "/workspace");

    expect(result.invokedSkills).toEqual([]);
    expect(result.foreignSkills).toEqual([]);
  });

  it("deduplicates ACTIVE and DONE views of the same skill", () => {
    const result = parseAntigravityTranscript(fixture, "/workspace/plugins/skills");
    expect(result.invokedSkills).toEqual(["haiku-writer"]);
  });

  it("marks a transcript with no result event as unusable", () => {
    expect(parseAntigravityTranscript("", "/workspace").usable).toBe(false);
  });

  it("marks a non-SUCCESS result as unusable", () => {
    const ndjson = JSON.stringify({ event: "result", result: { status: "ERROR", response: "agent crashed" } });

    const result = parseAntigravityTranscript(ndjson, "/workspace");

    expect(result.usable).toBe(false);
    expect(result.unusableReason).toMatch(/crashed|ERROR/i);
  });

  it("detects unauthenticated runs", () => {
    const ndjson = JSON.stringify({
      event: "result",
      result: { status: "ERROR", response: "Authentication required. Please visit the URL to log in" },
    });

    const result = parseAntigravityTranscript(ndjson, "/workspace");

    expect(result.usable).toBe(false);
    expect(result.unusableReason).toMatch(/not logged in|authentication required/i);
  });

  it("skips malformed JSON lines", () => {
    const ndjson = ["not json", fixture].join("\n");

    const result = parseAntigravityTranscript(ndjson, "/workspace/plugins/skills");

    expect(result.invokedSkills).toEqual(["haiku-writer"]);
    expect(result.usable).toBe(true);
  });
});
