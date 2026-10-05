import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Corpus } from "../../src/corpus/schema.js";
import { scoreSkill } from "../../src/metrics/score.js";
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

  it("leaves cost unreported when the result event carries none", () => {
    const transcript = JSON.stringify({ type: "result", subtype: "success", is_error: false });

    expect(parseClaudeCodeTranscript(transcript).costUsd).toBeUndefined();
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

  it("treats a provider execution error as unusable", () => {
    const result = parseClaudeCodeTranscript(
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }),
    );

    expect(result.usable).toBe(false);
    expect(result.unusableReason).toMatch(/error_during_execution/);
  });

  it("does not let an execution error pass a negative-only corpus", () => {
    const parsed = parseClaudeCodeTranscript(
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }),
    );
    const corpus: Corpus = {
      skill: "alpha",
      runs: 1,
      gates: { trigger: 0.9, noTrigger: 0.05 },
      shouldTrigger: [],
      shouldNotTrigger: ["stay quiet"],
    };
    const report = scoreSkill(corpus, [
      {
        prompt: "stay quiet",
        expectation: "no-trigger",
        runs: [
          {
            invokedSkills: parsed.invokedSkills,
            usable: parsed.usable,
            ...(parsed.costUsd === undefined ? {} : { costUsd: parsed.costUsd }),
            ...(parsed.unusableReason === undefined ? {} : { unusableReason: parsed.unusableReason }),
          },
        ],
      },
    ]);

    expect(report.passed).toBe(false);
  });

  it("keeps the recorded max-turns stop measurable", () => {
    expect(parseClaudeCodeTranscript(fixture("invoked.ndjson")).usable).toBe(true);
  });

  it("labels why a run is unusable with a reason code", () => {
    const result = (event: object) => parseClaudeCodeTranscript(JSON.stringify(event)).unusableCode;

    expect(parseClaudeCodeTranscript(fixture("not-logged-in.ndjson")).unusableCode).toBe("auth");
    expect(result({ type: "result", subtype: "error_during_execution", is_error: true })).toBe("provider-error");
    expect(result({ type: "system", subtype: "init" })).toBe("unsupported-transcript");
    expect(parseClaudeCodeTranscript(fixture("invoked.ndjson")).unusableCode).toBeUndefined();
  });
});
