/** Skill tool_use blocks from `claude -p --output-format stream-json`. See fixtures/claude-code. */

export interface TranscriptResult {
  readonly invokedSkills: readonly string[];
  readonly visibleSkills: readonly string[];
  readonly usable: boolean;
  readonly unusableReason?: string;
  readonly costUsd: number;
}

interface ContentBlock {
  readonly type?: string;
  readonly name?: string;
  readonly text?: string;
  readonly input?: { readonly skill?: unknown };
}

interface Event {
  readonly type?: string;
  readonly subtype?: string;
  readonly skills?: unknown;
  readonly is_error?: boolean;
  readonly total_cost_usd?: unknown;
  readonly message?: { readonly content?: unknown };
}

/** Claude Code answers with this text instead of failing when credentials are missing. */
const NOT_LOGGED_IN = /not logged in/i;

function contentBlocks(event: Event): readonly ContentBlock[] {
  const content = event.message?.content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

export function parseClaudeCodeTranscript(ndjson: string): TranscriptResult {
  const invoked: string[] = [];
  const seen = new Set<string>();
  let visibleSkills: readonly string[] = [];
  let sawResult = false;
  let costUsd = 0;
  let authFailure = false;

  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    let event: Event;
    try {
      event = JSON.parse(trimmed) as Event;
    } catch {
      continue;
    }

    if (event.type === "system" && Array.isArray(event.skills)) {
      visibleSkills = event.skills.filter((s): s is string => typeof s === "string");
    }

    if (event.type === "assistant") {
      for (const block of contentBlocks(event)) {
        if (block.type === "text" && typeof block.text === "string" && NOT_LOGGED_IN.test(block.text)) {
          authFailure = true;
        }
        if (block.type === "tool_use" && block.name === "Skill") {
          const skill = block.input?.skill;
          if (typeof skill === "string" && !seen.has(skill)) {
            seen.add(skill);
            invoked.push(skill);
          }
        }
      }
    }

    if (event.type === "result") {
      sawResult = true;
      if (typeof event.total_cost_usd === "number") costUsd = event.total_cost_usd;
    }
  }

  const unusableReason = authFailure
    ? "agent reported it is not logged in; no skill decision was made"
    : !sawResult
      ? "transcript contains no result event; the run was truncated or the process died"
      : undefined;

  return {
    invokedSkills: invoked,
    visibleSkills,
    usable: unusableReason === undefined,
    ...(unusableReason === undefined ? {} : { unusableReason }),
    costUsd,
  };
}
