import { cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const EXCLUDED = new Set(["evals"]);

/** Copy skill dirs only; skip evals (the corpus) and anything without SKILL.md. */
export function installPack(packDir: string, destination: string): void {
  mkdirSync(destination, { recursive: true });

  for (const skill of readdirSync(packDir)) {
    const source = join(packDir, skill);
    if (!statSync(source).isDirectory()) continue;
    try {
      statSync(join(source, "SKILL.md"));
    } catch {
      continue;
    }

    const target = join(destination, skill);
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source)) {
      if (EXCLUDED.has(entry)) continue;
      cpSync(join(source, entry), join(target, entry), { recursive: true });
    }
  }
}
