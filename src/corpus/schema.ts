import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const DEFAULT_RUNS = 5;
export const DEFAULT_TRIGGER_GATE = 0.9;
export const DEFAULT_NO_TRIGGER_GATE = 0.05;

const rate = z.number().min(0).max(1);

const rawCorpusSchema = z
  .object({
    skill: z.string().min(1),
    runs: z.number().int().positive().default(DEFAULT_RUNS),
    timeout_ms: z.number().int().positive().optional(),
    gates: z
      .object({
        trigger: rate.default(DEFAULT_TRIGGER_GATE),
        no_trigger: rate.default(DEFAULT_NO_TRIGGER_GATE),
      })
      .default({ trigger: DEFAULT_TRIGGER_GATE, no_trigger: DEFAULT_NO_TRIGGER_GATE }),
    should_trigger: z.array(z.string().min(1)).default([]),
    should_not_trigger: z.array(z.string().min(1)).default([]),
  })
  .strict();

export interface Gates {
  readonly trigger: number;
  readonly noTrigger: number;
}

export interface Corpus {
  readonly skill: string;
  readonly runs: number;
  readonly timeoutMs?: number;
  readonly gates: Gates;
  readonly shouldTrigger: readonly string[];
  readonly shouldNotTrigger: readonly string[];
}

export class CorpusError extends Error {
  constructor(source: string, detail: string) {
    super(`${source}: ${detail}`);
    this.name = "CorpusError";
  }
}

function findDuplicate(prompts: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const prompt of prompts) {
    if (seen.has(prompt)) return prompt;
    seen.add(prompt);
  }
  return undefined;
}

export function parseCorpus(text: string, source: string): Corpus {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    throw new CorpusError(source, `invalid YAML (${(error as Error).message})`);
  }

  const parsed = rawCorpusSchema.safeParse(document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".");
    throw new CorpusError(source, `${path ? `${path}: ` : ""}${issue?.message ?? "invalid corpus"}`);
  }

  const raw = parsed.data;
  const shouldTrigger = raw.should_trigger;
  const shouldNotTrigger = raw.should_not_trigger;

  if (shouldTrigger.length === 0 && shouldNotTrigger.length === 0) {
    throw new CorpusError(source, "corpus has no prompts; add should_trigger and/or should_not_trigger");
  }

  const duplicate = findDuplicate([...shouldTrigger]) ?? findDuplicate([...shouldNotTrigger]);
  if (duplicate !== undefined) {
    throw new CorpusError(source, `duplicate prompt "${duplicate}" would double-weight that case`);
  }

  const overlap = shouldTrigger.find((prompt) => shouldNotTrigger.includes(prompt));
  if (overlap !== undefined) {
    throw new CorpusError(source, `prompt "${overlap}" appears in both should_trigger and should_not_trigger`);
  }

  return {
    skill: raw.skill,
    runs: raw.runs,
    ...(raw.timeout_ms === undefined ? {} : { timeoutMs: raw.timeout_ms }),
    gates: { trigger: raw.gates.trigger, noTrigger: raw.gates.no_trigger },
    shouldTrigger,
    shouldNotTrigger,
  };
}
