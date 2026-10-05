import type { RunOutcome } from "../metrics/types.js";

export interface RunRequest {
  readonly prompt: string;
  readonly packDir: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  /** Aborted when the run is interrupted or exceeds its deadline or budget. */
  readonly signal?: AbortSignal;
}

export interface AgentAdapter {
  readonly id: string;
  runPrompt(request: RunRequest): Promise<RunOutcome>;
  /** Identifies the agent build behind the answers. Rejects when it cannot be read. */
  version?(): Promise<string>;
  close?(): Promise<void>;
}
