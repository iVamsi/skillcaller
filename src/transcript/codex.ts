import { resolve } from "node:path";
import type { UnusableCode } from "../metrics/types.js";

export interface CodexTranscriptResult {
  readonly invokedSkills: readonly string[];
  readonly foreignSkills: readonly string[];
  readonly usable: boolean;
  readonly unusableReason?: string;
  readonly unusableCode?: UnusableCode;
}

interface CommandItem {
  readonly type?: string;
  readonly command?: unknown;
  readonly status?: unknown;
  readonly exit_code?: unknown;
}

// Supported content read: a completed `sed` of SKILL.md with exit 0 (fixtures/codex/invoked.jsonl).
const CONTENT_READ = /\bsed\b/;

/** Path of a SKILL.md read in `codex exec --json`. Codex has no Skill tool. */
export function parseCodexTranscript(jsonl: string, packDir: string): CodexTranscriptResult {
  const packRoot = resolve(packDir);
  const invoked: string[] = [];
  const foreign: string[] = [];
  const problems: string[] = [];
  let sawTurnEnd = false;
  let openReads = 0;

  // Quoted first so paths with spaces stay whole
  const quotedPath = /['"]([^'"]*\/([^/'"]+)\/SKILL\.md)['"]/g;
  const barePath = /(?:^|\s)((?:[^\s'"]*)\/([^/\s'"]+)\/SKILL\.md)(?=\s|$)/g;

  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    let event: { type?: string; item?: CommandItem };
    try {
      event = JSON.parse(trimmed) as typeof event;
    } catch {
      continue;
    }

    if (event.type === "turn.completed") sawTurnEnd = true;

    const item = event.item;
    if (item?.type !== "command_execution" || typeof item.command !== "string") continue;

    const command = item.command;
    const matches = [...command.matchAll(quotedPath), ...command.matchAll(barePath)];
    if (matches.length === 0) continue;

    if (isIncomplete(event.type, item)) {
      openReads += 1;
      continue;
    }
    if (openReads > 0) openReads -= 1;

    if (item.status === "completed" && item.exit_code === 0 && CONTENT_READ.test(command)) {
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
      continue;
    }

    const label = command.length > 180 ? `${command.slice(0, 180)}…` : command;
    problems.push(
      typeof item.exit_code === "number" && item.exit_code !== 0
        ? `failed skill read: ${label}`
        : `ambiguous skill command: ${label}`,
    );
  }

  if (!sawTurnEnd) problems.unshift("transcript contains no completed turn");
  if (openReads > 0) problems.push("skill read started but did not complete");

  const unusableReason = problems.length === 0 ? undefined : problems.join("; ");
  return {
    invokedSkills: invoked,
    foreignSkills: foreign,
    usable: unusableReason === undefined,
    ...(unusableReason === undefined ? {} : { unusableReason, unusableCode: "unsupported-transcript" as const }),
  };
}

function isIncomplete(eventType: string | undefined, item: CommandItem): boolean {
  return eventType === "item.started" || item.status === "in_progress" || item.exit_code === null;
}
