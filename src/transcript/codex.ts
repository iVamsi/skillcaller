import { resolve } from "node:path";

export interface CodexTranscriptResult {
  readonly invokedSkills: readonly string[];
  readonly foreignSkills: readonly string[];
  readonly usable: boolean;
  readonly unusableReason?: string;
}

/** Path of a SKILL.md read in `codex exec --json`. Codex has no Skill tool. */
export function parseCodexTranscript(jsonl: string, packDir: string): CodexTranscriptResult {
  const packRoot = resolve(packDir);
  const invoked: string[] = [];
  const foreign: string[] = [];
  let sawTurnEnd = false;

  // Quoted first so paths with spaces stay whole
  const quotedPath = /['"]([^'"]*\/([^/'"]+)\/SKILL\.md)['"]/g;
  const barePath = /(?:^|\s)((?:[^\s'"]*)\/([^/\s'"]+)\/SKILL\.md)(?=\s|$)/g;

  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    let event: { type?: string; item?: { type?: string; command?: unknown } };
    try {
      event = JSON.parse(trimmed) as typeof event;
    } catch {
      continue;
    }

    if (event.type === "turn.completed") sawTurnEnd = true;

    const item = event.item;
    if (item?.type !== "command_execution" || typeof item.command !== "string") continue;

    const matches = [...item.command.matchAll(quotedPath), ...item.command.matchAll(barePath)];
    for (const match of matches) {
      const fullPath = match[1];
      const name = match[2];
      if (fullPath === undefined || name === undefined) continue;
      const parent = fullPath.slice(0, fullPath.length - `/${name}/SKILL.md`.length);
      if (parent === "") continue;

      const withinPack = resolve(parent) === packRoot || resolve(parent).startsWith(`${packRoot}/`);
      const bucket = withinPack ? invoked : foreign;
      if (!bucket.includes(name)) bucket.push(name);
    }
  }

  return {
    invokedSkills: invoked,
    foreignSkills: foreign,
    usable: sawTurnEnd,
    ...(sawTurnEnd ? {} : { unusableReason: "transcript contains no completed turn" }),
  };
}
