import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, RunRequest } from "../adapters/types.js";
import type { RunOutcome } from "../metrics/types.js";

interface CacheFile {
  readonly outcomes: RunOutcome[];
}

export class CachingAdapter implements AgentAdapter {
  readonly id: string;
  private readonly served = new Map<string, number>();
  /** Serialises writes per cache key. */
  private readonly writes = new Map<string, Promise<void>>();
  private readonly fingerprints = new Map<string, string>();

  constructor(
    private readonly inner: AgentAdapter,
    private readonly cacheDir: string,
  ) {
    this.id = inner.id;
  }

  async runPrompt(request: RunRequest): Promise<RunOutcome> {
    const key = this.keyFor(request);
    const file = join(this.cacheDir, `${key}.json`);
    const index = this.served.get(key) ?? 0;
    this.served.set(key, index + 1);

    const hit = readCache(file)?.outcomes[index];
    if (isOutcome(hit)) {
      return { ...hit, costUsd: 0 };
    }

    const outcome = await this.inner.runPrompt(request);
    if (outcome.usable) await this.store(file, key, outcome);
    return outcome;
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }

  private async store(file: string, key: string, outcome: RunOutcome): Promise<void> {
    const write = (this.writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => {
      const outcomes = (readCache(file)?.outcomes ?? []).filter(isOutcome);
      outcomes.push(outcome);
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(file, JSON.stringify({ outcomes } satisfies CacheFile));
    });
    this.writes.set(key, write);
    await write;
  }

  private keyFor(request: RunRequest): string {
    return createHash("sha256")
      .update(this.inner.id)
      .update(" ")
      .update(request.model ?? "default")
      .update(" ")
      .update(request.prompt)
      .update(" ")
      .update(this.packFingerprint(request.packDir))
      .digest("hex")
      .slice(0, 32);
  }

  /** Hash of every skill name and description in the pack. */
  private packFingerprint(packDir: string): string {
    const known = this.fingerprints.get(packDir);
    if (known !== undefined) return known;

    const hash = createHash("sha256");
    for (const name of readdirSync(packDir).sort()) {
      const skillFile = join(packDir, name, "SKILL.md");
      if (!existsSync(skillFile) || !statSync(join(packDir, name)).isDirectory()) continue;
      hash.update(name).update(" ").update(readFileSync(skillFile, "utf8").replace(/\r\n/g, "\n"));
    }
    const fingerprint = hash.digest("hex");
    this.fingerprints.set(packDir, fingerprint);
    return fingerprint;
  }
}

/** Guards against nulls and truncated files: a malformed entry must be a miss, not a verdict. */
function isOutcome(value: unknown): value is RunOutcome {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as RunOutcome).invokedSkills) &&
    typeof (value as RunOutcome).usable === "boolean"
  );
}

function readCache(file: string): CacheFile | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CacheFile;
  } catch {
    return undefined;
  }
}
