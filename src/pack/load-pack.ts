import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseCorpus, type Corpus } from "../corpus/schema.js";

export interface PackEntry {
  readonly directory: string;
  readonly description: string;
  readonly corpus: Corpus;
}

export interface Pack {
  readonly root: string;
  readonly entries: readonly PackEntry[];
  readonly skillsWithoutCorpus: readonly string[];
}

function frontmatterDescription(skillFile: string): string {
  // A leading BOM would empty the description
  const text = readFileSync(skillFile, "utf8").replace(/^\uFEFF/, "").trimStart();
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match?.[1] === undefined) return "";
  const parsed = parseYaml(match[1]) as { description?: unknown } | null;
  return typeof parsed?.description === "string" ? parsed.description : "";
}

/** Reads a directory of skills, each holding SKILL.md and optionally evals/triggers.yaml. */
export function loadPack(root: string): Pack {
  const entries: PackEntry[] = [];
  const withoutCorpus: string[] = [];
  let sawSkill = false;

  for (const name of readdirSync(root).sort()) {
    const directory = join(root, name);
    if (!statSync(directory).isDirectory()) continue;

    const skillFile = join(directory, "SKILL.md");
    try {
      statSync(skillFile);
    } catch {
      continue;
    }
    sawSkill = true;

    const corpusFile = join(directory, "evals", "triggers.yaml");
    let corpusText: string;
    try {
      corpusText = readFileSync(corpusFile, "utf8");
    } catch {
      withoutCorpus.push(name);
      continue;
    }

    const corpus = parseCorpus(corpusText, join(name, "evals", "triggers.yaml"));
    if (corpus.skill !== name) {
      throw new Error(
        `skill directory "${name}" holds a corpus for "${corpus.skill}"; the names must match`,
      );
    }
    entries.push({ directory, description: frontmatterDescription(skillFile), corpus });
  }

  if (!sawSkill) {
    throw new Error(`no skills found in ${root}; expected directories containing SKILL.md`);
  }

  return { root, entries, skillsWithoutCorpus: withoutCorpus };
}
