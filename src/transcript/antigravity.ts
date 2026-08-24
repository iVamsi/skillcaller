import { resolve } from "node:path";

export interface AntigravityTranscriptResult {
  readonly invokedSkills: readonly string[];
  readonly foreignSkills: readonly string[];
  readonly usable: boolean;
  readonly unusableReason?: string;
  readonly costUsd: number;
}

interface Event {
  readonly event?: string;
  readonly step_update?: {
    readonly step_type?: string;
    readonly tool_name?: string;
    readonly tool_info?: {
      readonly parameters?: {
        readonly AbsolutePath?: unknown;
      };
    };
  };
  readonly result?: {
    readonly status?: string;
    readonly response?: unknown;
  };
}

const NOT_LOGGED_IN = /not logged in|login required|unauthenticated|authentication required/i;

/** `agy -p --output-format stream-json`. Activation is view_file on SKILL.md. See fixtures/antigravity. */
export function parseAntigravityTranscript(ndjson: string, packDir: string): AntigravityTranscriptResult {
  const packRoot = resolve(packDir);
  const invoked: string[] = [];
  const foreign: string[] = [];
  let sawResult = false;
  let authFailure = false;
  let errorDetail: string | undefined;

  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    let event: Event;
    try {
      event = JSON.parse(trimmed) as Event;
    } catch {
      continue;
    }

    const path = event.step_update?.tool_info?.parameters?.AbsolutePath;
    if (typeof path === "string") {
      const match = /(?:^|\/)([^/]+)\/SKILL\.md$/.exec(path);
      if (match?.[1] !== undefined) {
        const name = match[1];
        const parent = path.slice(0, path.length - `/${name}/SKILL.md`.length);
        const resolvedParent = resolve(parent);
        const withinPack = parent === "" || resolvedParent === packRoot || resolvedParent.startsWith(`${packRoot}/`);
        const bucket = withinPack ? invoked : foreign;
        if (!bucket.includes(name)) bucket.push(name);
      }
    }

    if (event.event === "result") {
      sawResult = true;
      const status = event.result?.status;
      const response = event.result?.response;
      const responseText = typeof response === "string" ? response : "";
      if (status !== undefined && status !== "SUCCESS") {
        errorDetail = responseText || status;
      }
      if (NOT_LOGGED_IN.test(responseText) || (typeof status === "string" && NOT_LOGGED_IN.test(status))) {
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
