import type { AgentAdapter } from "../adapters/types.js";
import type { Corpus } from "../corpus/schema.js";
import type { PromptOutcome, RunOutcome } from "../metrics/types.js";
import type { PackEntry } from "../pack/load-pack.js";

export interface RunOptions {
  readonly packDir: string;
  readonly model?: string;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly onProgress?: (completed: number, total: number) => void;
}

export interface RunPackOptions {
  readonly packDir: string;
  readonly model?: string;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly onProgress?: (completed: number, total: number, skill: string) => void;
  readonly onSkillComplete?: (skill: string) => void;
}

interface PackJob {
  readonly entryIndex: number;
  readonly skill: string;
  readonly promptIndex: number;
  readonly prompt: string;
  readonly timeoutMs?: number;
}

const DEFAULT_CONCURRENCY = 2;

export async function runCorpus(
  corpus: Corpus,
  adapter: AgentAdapter,
  options: RunOptions,
): Promise<readonly PromptOutcome[]> {
  const [outcomes] = await runPackCorpora(
    [{ directory: options.packDir, description: "", corpus }],
    adapter,
    {
      packDir: options.packDir,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.onProgress === undefined
        ? {}
        : { onProgress: (c: number, t: number) => { options.onProgress?.(c, t); } }),
    },
  );
  return outcomes ?? [];
}

export async function runPackCorpora(
  entries: readonly PackEntry[],
  adapter: AgentAdapter,
  options: RunPackOptions,
): Promise<readonly (readonly PromptOutcome[])[]> {
  const promptsPerEntry = entries.map((entry) => [
    ...entry.corpus.shouldTrigger.map((prompt) => ({ prompt, expectation: "trigger" as const })),
    ...entry.corpus.shouldNotTrigger.map((prompt) => ({ prompt, expectation: "no-trigger" as const })),
  ]);

  const jobs: PackJob[] = [];
  const pendingJobsPerEntry: number[] = [];

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex];
    if (entry === undefined) continue;
    const prompts = promptsPerEntry[entryIndex] ?? [];
    let entryJobCount = 0;
    const timeoutMs = options.timeoutMs ?? entry.corpus.timeoutMs;

    for (let promptIndex = 0; promptIndex < prompts.length; promptIndex++) {
      const promptObj = prompts[promptIndex];
      if (promptObj === undefined) continue;
      for (let run = 0; run < entry.corpus.runs; run++) {
        jobs.push({
          entryIndex,
          skill: entry.corpus.skill,
          promptIndex,
          prompt: promptObj.prompt,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
        entryJobCount += 1;
      }
    }
    pendingJobsPerEntry[entryIndex] = entryJobCount;
  }

  const results: RunOutcome[][][] = promptsPerEntry.map((prompts) => prompts.map(() => []));
  const total = jobs.length;
  let completed = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const job = jobs[index];
      if (job === undefined) return;

      let outcome: RunOutcome;
      try {
        outcome = await adapter.runPrompt({
          prompt: job.prompt,
          packDir: options.packDir,
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(job.timeoutMs === undefined ? {} : { timeoutMs: job.timeoutMs }),
        });
      } catch (error) {
        outcome = {
          invokedSkills: [],
          usable: false,
          unusableReason: `adapter ${adapter.id} failed: ${(error as Error).message}`,
          costUsd: 0,
        };
      }

      results[job.entryIndex]?.[job.promptIndex]?.push(outcome);
      completed += 1;
      options.onProgress?.(completed, total, job.skill);

      const remaining = (pendingJobsPerEntry[job.entryIndex] ?? 1) - 1;
      pendingJobsPerEntry[job.entryIndex] = remaining;
      if (remaining === 0) {
        options.onSkillComplete?.(job.skill);
      }
    }
  };

  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));

  return entries.map((entry, entryIndex) => {
    const prompts = promptsPerEntry[entryIndex] ?? [];
    const entryResults = results[entryIndex] ?? [];
    return prompts.map((entryPrompt, promptIndex) => ({
      prompt: entryPrompt.prompt,
      expectation: entryPrompt.expectation,
      runs: entryResults[promptIndex] ?? [],
    }));
  });
}
