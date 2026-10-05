import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validatePack } from "../../src/commands/validate.js";

function pack(skills: Record<string, { frontmatter?: string; corpus?: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "skillcaller-validate-"));
  for (const [name, spec] of Object.entries(skills)) {
    mkdirSync(join(dir, name, "evals"), { recursive: true });
    writeFileSync(
      join(dir, name, "SKILL.md"),
      `---\n${spec.frontmatter ?? `name: ${name}\ndescription: Use when doing ${name}`}\n---\n\nbody\n`,
    );
    if (spec.corpus !== undefined) writeFileSync(join(dir, name, "evals", "triggers.yaml"), spec.corpus);
  }
  return dir;
}

const corpusFor = (name: string) => `skill: ${name}\nshould_trigger: ["do ${name}"]\n`;

describe("validatePack", () => {
  it("accepts a well-formed pack", () => {
    const result = validatePack(pack({ alpha: { corpus: corpusFor("alpha") } }));

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("warns about a skill with no corpus instead of failing", () => {
    const result = validatePack(pack({ alpha: { corpus: corpusFor("alpha") }, beta: {} }));

    expect(result.errors).toEqual([]);
    expect(result.warnings.join()).toMatch(/beta.*no evals\/triggers.yaml/);
  });

  it("reports every frontmatter problem, not just the first", () => {
    const result = validatePack(
      pack({
        alpha: { frontmatter: "name: Alpha_Skill\ndescription: d", corpus: corpusFor("alpha") },
        beta: { frontmatter: "name: gamma\ndescription: d", corpus: corpusFor("beta") },
        delta: { frontmatter: "name: delta", corpus: corpusFor("delta") },
        omega: { frontmatter: `name: omega\ndescription: ${"x".repeat(1025)}`, corpus: corpusFor("omega") },
      }),
    );

    expect(result.errors).toEqual([
      expect.stringMatching(/alpha.*lowercase letters, digits and hyphens/),
      expect.stringMatching(/beta.*name "gamma" does not match its directory/),
      expect.stringMatching(/delta.*no description/),
      expect.stringMatching(/omega.*longer than 1024/),
    ]);
  });

  it("reports a corpus problem", () => {
    const result = validatePack(pack({ alpha: { corpus: corpusFor("beta") } }));

    expect(result.errors.join()).toMatch(/holds a corpus for "beta"/);
  });

  it("reports a link that would be refused at staging", () => {
    const dir = pack({ alpha: { corpus: corpusFor("alpha") } });
    symlinkSync("/etc/hosts", join(dir, "alpha", "hosts"));

    expect(validatePack(dir).errors.join()).toMatch(/refusing to stage alpha\/hosts/);
  });
});
