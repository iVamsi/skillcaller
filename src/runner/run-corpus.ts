import type { AgentAdapter } from "../adapters/types.js";
import type { Corpus } from "../corpus/schema.js";
import type { Expectation, PromptOutcome, RunOutcome } from "../metrics/types.js";

export interface RunOptions {
  readonly packDir: string;
  readonly model?: string;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly onProgress?: (completed: number, total: number) => void;
}

interface Job {
  readonly promptIndex: number;
  readonly prompt: string;
}

const DEFAULT_CONCURRENCY = 2;

export async function runCorpus(
  corpus: Corpus,
  adapter: AgentAdapter,
  options: RunOptions,
): Promise<readonly PromptOutcome[]> {
  const prompts: { prompt: string; expectation: Expectation }[] = [
    ...corpus.shouldTrigger.map((prompt) => ({ prompt, expectation: "trigger" as const })),
    ...corpus.shouldNotTrigger.map((prompt) => ({ prompt, expectation: "no-trigger" as const })),
  ];

  const jobs: Job[] = prompts.flatMap((entry, promptIndex) =>
    Array.from({ length: corpus.runs }, () => ({ promptIndex, prompt: entry.prompt })),
  );

  const results: RunOutcome[][] = prompts.map(() => []);
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
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
      } catch (error) {
        outcome = {
          invokedSkills: [],
          usable: false,
          unusableReason: `adapter ${adapter.id} failed: ${(error as Error).message}`,
          costUsd: 0,
        };
      }

      results[job.promptIndex]?.push(outcome);
      completed += 1;
      options.onProgress?.(completed, total);
    }
  };

  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));

  return prompts.map((entry, index) => ({
    prompt: entry.prompt,
    expectation: entry.expectation,
    runs: results[index] ?? [],
  }));
}
