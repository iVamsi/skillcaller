export interface RunOutcome {
  readonly invokedSkills: readonly string[];
  /** Skills reached outside the pack under test. */
  readonly foreignSkills?: readonly string[];
  readonly usable: boolean;
  readonly unusableReason?: string;
  readonly costUsd: number;
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
  readonly totalCostUsd: number;
  /** Foreign skills seen during this skill's runs, deduplicated. */
  readonly contamination: readonly string[];
}
