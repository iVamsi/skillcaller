import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { packDigest } from "../adapters/install-pack.js";
import { loadPack, readFrontmatter } from "../pack/load-pack.js";

export interface ValidationResult {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

/** Every problem a run would hit, found without calling an agent. */
export function validatePack(root: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const name of readdirSync(root).sort()) {
    const skillFile = join(root, name, "SKILL.md");
    if (!statSync(join(root, name)).isDirectory() || !existsSync(skillFile)) continue;
    errors.push(...frontmatterProblems(name, skillFile));
    if (!existsSync(join(root, name, "evals", "triggers.yaml"))) {
      warnings.push(`${name}: no evals/triggers.yaml, so it would not be measured`);
    }
  }

  // Each of these stops at its first problem, so they run separately to report one of each
  for (const check of [() => loadPack(root), () => packDigest(root)]) {
    try {
      check();
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  return { errors, warnings };
}

/** The Agent Skills rules for `name` and `description`. */
function frontmatterProblems(directory: string, skillFile: string): string[] {
  let frontmatter;
  try {
    frontmatter = readFrontmatter(skillFile);
  } catch (error) {
    return [`${directory}: SKILL.md frontmatter is not valid YAML (${(error as Error).message})`];
  }

  const problems: string[] = [];
  const { name, description } = frontmatter;
  if (typeof name !== "string" || name === "") {
    problems.push(`${directory}: SKILL.md has no name`);
  } else if (!NAME.test(name) || name.length > MAX_NAME_LENGTH) {
    problems.push(
      `${directory}: name "${name}" must be at most ${MAX_NAME_LENGTH} lowercase letters, digits and hyphens, ` +
        `without a leading, trailing or doubled hyphen`,
    );
  } else if (name !== directory) {
    problems.push(`${directory}: name "${name}" does not match its directory`);
  }

  if (typeof description !== "string" || description.trim() === "") {
    problems.push(`${directory}: SKILL.md has no description, so no agent can choose it`);
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    problems.push(`${directory}: description is longer than ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  return problems;
}
