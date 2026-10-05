export interface RunOutcome {
  readonly invokedSkills: readonly string[];
  /** Skills reached outside the pack under test. */
  readonly foreignSkills?: readonly string[];
  readonly usable: boolean;
  readonly unusableReason?: string;
  /** Undefined when the agent does not report cost. */
  readonly costUsd?: number;
  /** Served from the cache rather than run during this invocation. */
  readonly cached?: true;
}

export type Expectation = "trigger" | "no-trigger";

export interface PromptOutcome {
  readonly prompt: string;
  readonly expectation: Expectation;
  readonly runs: readonly RunOutcome[];
}

export interface PromptReport {
  readonly prompt: string;
  readonly expectation: Expectation;
  /** Undefined when no run was usable. */
  readonly rate: number | undefined;
  readonly usableRuns: number;
  readonly totalRuns: number;
  /** Other skills that answered this prompt, by invocation count. */
  readonly otherSkills: Readonly<Record<string, number>>;
}

export interface SkillReport {
  readonly skill: string;
  readonly prompts: readonly PromptReport[];
  /** Mean activation across should_trigger prompts. */
  readonly triggerRate: number | undefined;
  /** Worst (highest) activation across should_not_trigger prompts. */
  readonly noTriggerRate: number | undefined;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly unusableRuns: number;
  /** Redacted unusable reasons, by run count. */
  readonly unusableReasons: Readonly<Record<string, number>>;
  readonly cachedRuns: number;
  /** Fresh runs whose agent reported no cost; they are missing from totalCostUsd. */
  readonly unpricedRuns: number;
  /** Spent during this invocation; cached runs cost nothing. */
  readonly totalCostUsd: number;
  /** Foreign skills seen during this skill's runs, deduplicated. */
  readonly contamination: readonly string[];
}
