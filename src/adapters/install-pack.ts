import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const EXCLUDED = new Set(["evals"]);

/**
 * Copy skill dirs only; skip evals (the corpus) and anything without SKILL.md.
 * Returns a digest of exactly the bytes written, so a cache key can never describe a different pack.
 */
export function installPack(packDir: string, destination: string): string {
  mkdirSync(destination, { recursive: true });
  return walkPack(packDir, (rel, content) => {
    const target = join(destination, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  });
}

/** Digest of the files installPack would stage. */
export function packDigest(packDir: string): string {
  return walkPack(packDir, () => undefined);
}

function walkPack(packDir: string, visit: (rel: string, content: Buffer) => void): string {
  const root = resolve(packDir);
  const hash = createHash("sha256");
  const emit = (rel: string, content: Buffer): void => {
    // Line endings do not change what the agent reads
    hash.update(rel).update("\0").update(content.toString("utf8").replace(/\r\n/g, "\n")).update("\0");
    visit(rel, content);
  };

  for (const entry of readdirSync(root, { withFileTypes: true }).sort(byName)) {
    const source = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw stageError(entry.name, "symlink");
    }
    if (!entry.isDirectory()) continue;
    if (!isSkillDir(source, root)) continue;
    walkTree(source, root, emit);
  }
  return hash.digest("hex");
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
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

function walkTree(source: string, root: string, emit: (rel: string, content: Buffer) => void): void {
  for (const entry of readdirSync(source, { withFileTypes: true }).sort(byName)) {
    if (EXCLUDED.has(entry.name)) continue;
    const from = join(source, entry.name);
    const rel = relative(root, from);
    // ponytail: lstat via Dirent then read; the run stages from its own snapshot, so only that copy step can race
    if (entry.isSymbolicLink()) throw stageError(rel, "symlink");
    if (entry.isDirectory()) {
      walkTree(from, root, emit);
      continue;
    }
    if (!entry.isFile()) throw stageError(rel, "not a regular file");
    emit(rel, readFileSync(from));
  }
}

function stageError(path: string, why: string): Error {
  return new Error(`refusing to stage ${path}: ${why}`);
}
