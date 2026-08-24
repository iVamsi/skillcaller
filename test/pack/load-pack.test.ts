import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPack } from "../../src/pack/load-pack.js";

function pack(skills: Record<string, { description?: string; corpus?: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "skillcaller-loadpack-"));
  for (const [name, spec] of Object.entries(skills)) {
    mkdirSync(join(dir, name, "evals"), { recursive: true });
    writeFileSync(
      join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${spec.description ?? "a description"}\n---\n\nbody\n`,
    );
    if (spec.corpus !== undefined) writeFileSync(join(dir, name, "evals", "triggers.yaml"), spec.corpus);
  }
  return dir;
}

const corpusFor = (name: string) => `skill: ${name}\nshould_trigger: ["do ${name} things"]\n`;

describe("loadPack", () => {
  it("loads every skill that ships a corpus", () => {
    const dir = pack({ alpha: { corpus: corpusFor("alpha") }, beta: { corpus: corpusFor("beta") } });

    const loaded = loadPack(dir);

    expect(loaded.entries.map((entry) => entry.corpus.skill)).toEqual(["alpha", "beta"]);
  });

  it("reports skills that have no corpus rather than skipping them quietly", () => {
    // An unmeasured skill is not a passing one; silence here would hide it.
    const dir = pack({ alpha: { corpus: corpusFor("alpha") }, beta: {} });

    const loaded = loadPack(dir);

    expect(loaded.skillsWithoutCorpus).toEqual(["beta"]);
  });

  it("fails when a corpus names a different skill than its directory", () => {
    const dir = pack({ alpha: { corpus: "skill: typo\nshould_trigger: [\"x\"]\n" } });

    expect(() => loadPack(dir)).toThrow(/alpha.*typo/i);
  });

  it("ignores directories that are not skills", () => {
    const dir = pack({ alpha: { corpus: corpusFor("alpha") } });
    mkdirSync(join(dir, "node_modules"), { recursive: true });

    expect(loadPack(dir).entries).toHaveLength(1);
  });

  it("exposes each skill's description so the report can explain a failure", () => {
    const dir = pack({ alpha: { description: "Use when doing alpha work", corpus: corpusFor("alpha") } });

    expect(loadPack(dir).entries[0]?.description).toBe("Use when doing alpha work");
  });

  it("reads frontmatter through a byte order mark or a leading blank line", () => {
    // An editor-added BOM silently emptied the description
    const dir = mkdtempSync(join(tmpdir(), "skillcaller-bom-"));
    mkdirSync(join(dir, "alpha", "evals"), { recursive: true });
    writeFileSync(
      join(dir, "alpha", "SKILL.md"),
      `\uFEFF\n---\nname: alpha\ndescription: Use when doing alpha work\n---\n\nbody\n`,
    );
    writeFileSync(join(dir, "alpha", "evals", "triggers.yaml"), corpusFor("alpha"));

    expect(loadPack(dir).entries[0]?.description).toBe("Use when doing alpha work");
  });

  it("fails clearly when the directory holds no skills at all", () => {
    expect(() => loadPack(mkdtempSync(join(tmpdir(), "empty-")))).toThrow(/no skills/i);
  });
});
