import { describe, expect, it } from "vitest";
import { parseCorpus } from "../../src/corpus/schema.js";

const minimal = `
skill: building-cmp-uis
should_trigger:
  - "add a compose multiplatform screen"
should_not_trigger:
  - "write a kotlin extension function"
`;

describe("parseCorpus", () => {
  it("parses a minimal corpus and applies defaults", () => {
    const corpus = parseCorpus(minimal, "triggers.yaml");

    expect(corpus.skill).toBe("building-cmp-uis");
    expect(corpus.shouldTrigger).toEqual(["add a compose multiplatform screen"]);
    expect(corpus.shouldNotTrigger).toEqual(["write a kotlin extension function"]);
    // Activation is a rate, so a single run cannot measure it. Five is the documented default.
    expect(corpus.runs).toBe(5);
    expect(corpus.gates).toEqual({ trigger: 0.9, noTrigger: 0.05 });
  });

  it("honours explicit runs and gates", () => {
    const corpus = parseCorpus(
      `skill: s\nruns: 9\ngates: { trigger: 0.75, no_trigger: 0.2 }\nshould_trigger: ["a"]`,
      "triggers.yaml",
    );

    expect(corpus.runs).toBe(9);
    expect(corpus.gates).toEqual({ trigger: 0.75, noTrigger: 0.2 });
  });

  it("rejects a corpus with no prompts at all, naming the file", () => {
    expect(() => parseCorpus(`skill: s`, "evals/triggers.yaml")).toThrow(/evals\/triggers\.yaml/);
  });

  it("rejects gate values outside 0..1", () => {
    expect(() => parseCorpus(`skill: s\ngates: { trigger: 1.5 }\nshould_trigger: ["a"]`, "f.yaml")).toThrow();
  });

  it("rejects duplicate prompts, which would silently double-weight a case", () => {
    expect(() =>
      parseCorpus(`skill: s\nshould_trigger: ["same", "same"]`, "f.yaml"),
    ).toThrow(/duplicate/i);
  });

  it("rejects a prompt that appears in both lists", () => {
    expect(() =>
      parseCorpus(`skill: s\nshould_trigger: ["x"]\nshould_not_trigger: ["x"]`, "f.yaml"),
    ).toThrow(/both/i);
  });

  it("reports malformed YAML with the file name", () => {
    expect(() => parseCorpus(`skill: [unclosed`, "broken.yaml")).toThrow(/broken\.yaml/);
  });

  it("parses optional timeout_ms when provided", () => {
    const corpus = parseCorpus(`skill: s\ntimeout_ms: 45000\nshould_trigger: ["a"]`, "triggers.yaml");
    expect(corpus.timeoutMs).toBe(45000);
  });
});
