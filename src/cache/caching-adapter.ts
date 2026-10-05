import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packDigest } from "../adapters/install-pack.js";
import type { AgentAdapter, RunRequest } from "../adapters/types.js";
import type { RunOutcome } from "../metrics/types.js";
import { VERSION } from "../version.js";

/** Bump when the stored sample format changes; older layouts live in other directories and are never read. */
const SCHEMA = "v2";

export interface CachingAdapterOptions {
  readonly warn?: (message: string) => void;
}

/**
 * Stores each repeat of a prompt as its own file, `<key>/<n>.json`. Request n for a key always maps to
 * sample n, so a sample written during this run is never counted twice, and writers never share a file.
 */
export class CachingAdapter implements AgentAdapter {
  readonly id: string;
  private readonly served = new Map<string, number>();
  private readonly digests = new Map<string, string>();
  private readonly warn: (message: string) => void;
  private identity: Promise<string | undefined> | undefined;

  constructor(
    private readonly inner: AgentAdapter,
    private readonly cacheDir: string,
    options: CachingAdapterOptions = {},
  ) {
    this.id = inner.id;
    this.warn = options.warn ?? ((message) => process.stderr.write(`warning: ${message}\n`));
  }

  async runPrompt(request: RunRequest): Promise<RunOutcome> {
    const identity = await this.agentIdentity();
    if (identity === undefined) return this.inner.runPrompt(request);

    const key = this.keyFor(identity, request);
    const index = this.served.get(key) ?? 0;
    this.served.set(key, index + 1);
    const file = join(this.cacheDir, SCHEMA, key, `${index}.json`);

    const hit = this.read(file);
    if (hit !== undefined) return { ...hit, costUsd: 0, cached: true };

    const outcome = await this.inner.runPrompt(request);
    if (outcome.usable) this.store(file, outcome);
    return outcome;
  }

  /**
   * How many of these requests a run would answer from the cache, numbering samples exactly as
   * runPrompt does. Reads only; nothing is reserved or written.
   */
  async countCached(requests: readonly RunRequest[]): Promise<number> {
    const identity = await this.agentIdentity();
    if (identity === undefined) return 0;
    const next = new Map(this.served);
    let cached = 0;
    for (const request of requests) {
      const key = this.keyFor(identity, request);
      const index = next.get(key) ?? 0;
      next.set(key, index + 1);
      if (this.read(join(this.cacheDir, SCHEMA, key, `${index}.json`)) !== undefined) cached += 1;
    }
    return cached;
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }

  private agentIdentity(): Promise<string | undefined> {
    this.identity ??= (this.inner.version?.() ?? Promise.resolve("")).then(
      (version) => `${VERSION} ${this.inner.id} ${version}`,
      (error: unknown) => {
        this.warn(`cannot read the ${this.id} version (${(error as Error).message}); caching is off for this run`);
        return undefined;
      },
    );
    return this.identity;
  }

  private keyFor(identity: string, request: RunRequest): string {
    let digest = this.digests.get(request.packDir);
    if (digest === undefined) {
      digest = packDigest(request.packDir);
      this.digests.set(request.packDir, digest);
    }
    return createHash("sha256")
      .update(JSON.stringify([identity, request.model ?? null, request.timeoutMs ?? null, request.prompt, digest]))
      .digest("hex")
      .slice(0, 32);
  }

  private read(file: string): RunOutcome | undefined {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
    try {
      const value: unknown = JSON.parse(text);
      if (isOutcome(value)) return value;
    } catch {
      // reported below
    }
    this.warn(`ignoring malformed cache entry ${file}`);
    return undefined;
  }

  /** A failed write costs a future cache hit, never the answer already paid for. */
  private store(file: string, outcome: RunOutcome): void {
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(temp, JSON.stringify(outcome));
      renameSync(temp, file);
    } catch (error) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // the directory itself is unusable; nothing was left behind
      }
      this.warn(`could not write cache entry ${file}: ${(error as Error).message}`);
    }
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Only usable answers are stored, so anything else is a corrupt or foreign file. */
function isOutcome(value: unknown): value is RunOutcome {
  if (typeof value !== "object" || value === null) return false;
  const outcome = value as Record<string, unknown>;
  return (
    outcome.usable === true &&
    isStringArray(outcome.invokedSkills) &&
    (outcome.foreignSkills === undefined || isStringArray(outcome.foreignSkills)) &&
    typeof outcome.costUsd === "number" &&
    Number.isFinite(outcome.costUsd)
  );
}
