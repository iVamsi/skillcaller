import { resolve } from "node:path";

export interface CursorTranscriptResult {
  readonly invokedSkills: readonly string[];
  /** Skills read from outside the pack directory: the environment was not isolated. */
  readonly foreignSkills: readonly string[];
  readonly usable: boolean;
  readonly unusableReason?: string;
  readonly costUsd: number;
}

interface ToolCallEvent {
  readonly type?: string;
  readonly subtype?: string;
  readonly tool_call?: {
    readonly readToolCall?: {
      readonly args?: {
        readonly path?: unknown;
      };
    };
  };
  readonly is_error?: boolean;
  readonly result?: unknown;
}

const NOT_LOGGED_IN = /not logged in|login required|unauthenticated/i;

/**
 * Parses `cursor-agent -p --output-format stream-json` output.
 *
 * Like Codex, Cursor reads SKILL.md with a file tool (`readToolCall`) rather than a dedicated
 * Skill tool. Invocations targeting the pack directory are recorded as hits; reads from outside
 * the pack (e.g. ~/.cursor/skills or ~/.agents/skills) are reported as foreign contamination.
 */
export function parseCursorTranscript(ndjson: string, packDir: string): CursorTranscriptResult {
  const packRoot = resolve(packDir);
  const invoked: string[] = [];
  const foreign: string[] = [];
  let sawResult = false;
  let authFailure = false;
  let errorDetail: string | undefined;

  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    let event: ToolCallEvent;
    try {
      event = JSON.parse(trimmed) as ToolCallEvent;
    } catch {
      continue;
    }

    const path = event.tool_call?.readToolCall?.args?.path;
    if (typeof path === "string") {
      const match = /(?:^|\/)([^/]+)\/SKILL\.md$/.exec(path);
      if (match?.[1] !== undefined) {
        const name = match[1];
        const parent = path.slice(0, path.length - `/${name}/SKILL.md`.length);
        const withinPack = parent === "" || resolve(parent) === packRoot || resolve(parent).startsWith(`${packRoot}/`);
        const bucket = withinPack ? invoked : foreign;
        if (!bucket.includes(name)) bucket.push(name);
      }
    }

    if (event.type === "result") {
      sawResult = true;
      if (event.is_error === true) {
        errorDetail = typeof event.result === "string" ? event.result : "cursor-agent returned an error";
      }
      if (typeof event.result === "string" && NOT_LOGGED_IN.test(event.result)) {
        authFailure = true;
      }
    }
  }

  const unusableReason = authFailure
    ? "agent reported it is not logged in; no skill decision was made"
    : errorDetail !== undefined
      ? errorDetail
      : !sawResult
        ? "transcript contains no result event; the run was truncated or the process died"
        : undefined;

  return {
    invokedSkills: invoked,
    foreignSkills: foreign,
    usable: unusableReason === undefined,
    ...(unusableReason === undefined ? {} : { unusableReason }),
    costUsd: 0,
  };
}
