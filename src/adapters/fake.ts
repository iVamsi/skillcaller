import { readFileSync } from "node:fs";
import type { RunOutcome } from "../metrics/types.js";
import type { AgentAdapter, RunRequest } from "./types.js";

type Script = Record<string, string[][]>;

/** Scripted outcomes for CI. No network, no API key. */
export class FakeAdapter implements AgentAdapter {
  readonly id = "fake";
  private readonly calls = new Map<string, number>();

  constructor(private readonly script: Script = {}) {}

  static fromFile(path: string): FakeAdapter {
    return new FakeAdapter(JSON.parse(readFileSync(path, "utf8")) as Script);
  }

  runPrompt(request: RunRequest): Promise<RunOutcome> {
    const sequence = this.script[request.prompt];
    if (sequence === undefined || sequence.length === 0) {
      return Promise.resolve({ invokedSkills: [], usable: true, costUsd: 0 });
    }
    const index = this.calls.get(request.prompt) ?? 0;
    this.calls.set(request.prompt, index + 1);
    return Promise.resolve({
      invokedSkills: sequence[index % sequence.length] ?? [],
      usable: true,
      costUsd: 0,
    });
  }
}
