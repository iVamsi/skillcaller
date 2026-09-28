import { copyFileSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const EXCLUDED = new Set(["evals"]);

/** Copy skill dirs only; skip evals (the corpus) and anything without SKILL.md. */
export function installPack(packDir: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  const root = resolve(packDir);

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const source = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw stageError(entry.name, "symlink");
    }
    if (!entry.isDirectory()) continue;
    if (!isSkillDir(source, root)) continue;
    copyTree(source, join(destination, entry.name), root);
  }
}

function isSkillDir(source: string, root: string): boolean {
  const skillFile = join(source, "SKILL.md");
  let stat;
  try {
    stat = lstatSync(skillFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const rel = relative(root, skillFile);
  if (stat.isSymbolicLink()) throw stageError(rel, "symlink");
  if (!stat.isFile()) throw stageError(rel, "not a regular file");
  return true;
}

function copyTree(source: string, target: string, root: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name)) continue;
    const from = join(source, entry.name);
    const rel = relative(root, from);
    // ponytail: lstat via Dirent then copy; a swap during staging waits on the W06 snapshot
    if (entry.isSymbolicLink()) throw stageError(rel, "symlink");
    if (entry.isDirectory()) {
      copyTree(from, join(target, entry.name), root);
      continue;
    }
    if (!entry.isFile()) throw stageError(rel, "not a regular file");
    copyFileSync(from, join(target, entry.name));
  }
}

function stageError(path: string, why: string): Error {
  return new Error(`refusing to stage ${path}: ${why}`);
}
