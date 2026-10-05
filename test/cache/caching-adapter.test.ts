import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CachingAdapter } from "../../src/cache/caching-adapter.js";
import type { AgentAdapter, RunRequest } from "../../src/adapters/types.js";
import type { RunOutcome } from "../../src/metrics/types.js";

function countingAdapter(outcome: RunOutcome = { invokedSkills: ["alpha"], usable: true, costUsd: 0.02 }) {
  let calls = 0;
  const adapter: AgentAdapter = {
    id: "counting",
    runPrompt: (_request: RunRequest) => {
      calls += 1;
      return Promise.resolve(outcome);
    },
  };
  return { adapter, calls: () => calls };
}

function pack(descriptions: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "skillcaller-cache-pack-"));
  for (const [name, description] of Object.entries(descriptions)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
  }
  return dir;
}

const cacheDir = () => mkdtempSync(join(tmpdir(), "skillcaller-cache-"));

function sampleFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name));
}

describe("CachingAdapter", () => {
  it("reuses a cached result instead of paying for the same run twice", async () => {
    const { adapter, calls } = countingAdapter();
    const dir = cacheDir();
    const packDir = pack({ alpha: "does alpha" });

    const first = await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir });
    const second = await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir });

    expect(calls()).toBe(1);
    // Same verdict, but the cached run reports no cost because nothing was spent on it.
    expect(second.invokedSkills).toEqual(first.invokedSkills);
    expect(second.usable).toBe(true);
  });

  it("re-runs when the prompt changes", async () => {
    const { adapter, calls } = countingAdapter();
    const dir = cacheDir();
    const packDir = pack({ alpha: "does alpha" });

    await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir });
    await new CachingAdapter(adapter, dir).runPrompt({ prompt: "different", packDir });

    expect(calls()).toBe(2);
  });

  it("re-runs when another skill's description changes", async () => {
    // caching on one skill's text alone would serve a stale verdict after an unrelated edit
    const { adapter, calls } = countingAdapter();
    const dir = cacheDir();

    await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir: pack({ alpha: "does alpha", beta: "does beta" }) });
    await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir: pack({ alpha: "does alpha", beta: "REWRITTEN" }) });

    expect(calls()).toBe(2);
  });

  it("re-runs when the model changes", async () => {
    const { adapter, calls } = countingAdapter();
    const dir = cacheDir();
    const packDir = pack({ alpha: "does alpha" });

    await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir, model: "haiku" });
    await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir, model: "opus" });

    expect(calls()).toBe(2);
  });

  it("never caches an unusable run", async () => {
    // Auth failures and crashes are transient; caching one would poison every later run.
    const { adapter, calls } = countingAdapter({
      invokedSkills: [], usable: false, unusableReason: "not logged in", costUsd: 0,
    });
    const dir = cacheDir();
    const packDir = pack({ alpha: "does alpha" });

    await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir });
    await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir });

    expect(calls()).toBe(2);
  });

  it("reports a cached run as free, since no tokens were spent", async () => {
    const { adapter } = countingAdapter();
    const dir = cacheDir();
    const packDir = pack({ alpha: "does alpha" });

    await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir });
    const cached = await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir });

    expect(cached.costUsd).toBe(0);
    expect(cached.cached).toBe(true);
    expect(cached.invokedSkills).toEqual(["alpha"]);
  });

  it("keeps different agents apart", async () => {
    const { adapter, calls } = countingAdapter();
    const dir = cacheDir();
    const packDir = pack({ alpha: "does alpha" });
    const other: AgentAdapter = { id: "other", runPrompt: (request) => adapter.runPrompt(request) };

    await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir });
    await new CachingAdapter(other, dir).runPrompt({ prompt: "p", packDir });

    expect(calls()).toBe(2);
  });

  it("treats a null sample as a miss, not as a usable answer", async () => {
    const dir = cacheDir();
    const packDir = pack({ alpha: "does alpha" });
    const { adapter, calls } = countingAdapter();

    await new CachingAdapter(adapter, dir, { warn: () => undefined }).runPrompt({ prompt: "p", packDir });
    for (const file of sampleFiles(dir)) writeFileSync(file, "null");

    const outcome = await new CachingAdapter(adapter, dir, { warn: () => undefined }).runPrompt({ prompt: "p", packDir });

    expect(outcome.usable).toBe(true);
    expect(outcome.invokedSkills).toEqual(["alpha"]);
    expect(calls()).toBe(2);
  });

  it("treats valid JSON of the wrong shape as a miss with a warning instead of crashing", async () => {
    const dir = cacheDir();
    const packDir = pack({ alpha: "does alpha" });
    const { adapter, calls } = countingAdapter();
    await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir });
    for (const file of sampleFiles(dir)) {
      writeFileSync(file, JSON.stringify({ invokedSkills: ["alpha"], usable: true, costUsd: "free" }));
    }
    const warnings: string[] = [];

    const outcome = await new CachingAdapter(adapter, dir, { warn: (m) => warnings.push(m) }).runPrompt({ prompt: "p", packDir });

    expect(outcome.cached).toBeUndefined();
    expect(calls()).toBe(2);
    expect(warnings).toHaveLength(1);
  });

  it("keeps every answer when the same prompt is cached concurrently", async () => {
    const dir = cacheDir();
    const packDir = pack({ alpha: "does alpha" });
    let calls = 0;
    const adapter: AgentAdapter = {
      id: "concurrent",
      runPrompt: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { invokedSkills: ["alpha"], usable: true, costUsd: 0.01 };
      },
    };
    const caching = new CachingAdapter(adapter, dir);

    await Promise.all([1, 2, 3, 4].map(() => caching.runPrompt({ prompt: "p", packDir })));

    const stored = sampleFiles(dir).map((file) => JSON.parse(readFileSync(file, "utf8")) as unknown);
    expect(calls).toBe(4);
    expect(stored).toHaveLength(4);
    expect(stored.every((entry) => entry !== null)).toBe(true);
  });

  it("does not let a second process overwrite samples another process already stored", async () => {
    // Each process read-modify-wrote one shared file, so the slower one erased the other's samples
    const dir = cacheDir();
    const packDir = pack({ alpha: "does alpha" });
    const { adapter } = countingAdapter();
    const first = new CachingAdapter(adapter, dir);
    const second = new CachingAdapter(adapter, dir);

    await first.runPrompt({ prompt: "p", packDir });
    await first.runPrompt({ prompt: "p", packDir });
    await second.runPrompt({ prompt: "p", packDir });
    await second.runPrompt({ prompt: "p", packDir });
    await second.runPrompt({ prompt: "p", packDir });

    expect(sampleFiles(dir)).toHaveLength(3);
  });

  it("returns the live answer when the cache cannot be written", async () => {
    const blocked = join(cacheDir(), "file");
    writeFileSync(blocked, "not a directory");
    const { adapter } = countingAdapter();
    const warnings: string[] = [];

    const outcome = await new CachingAdapter(adapter, blocked, { warn: (m) => warnings.push(m) }).runPrompt({
      prompt: "p",
      packDir: pack({ alpha: "does alpha" }),
    });

    expect(outcome.invokedSkills).toEqual(["alpha"]);
    expect(warnings).toHaveLength(1);
  });

  it("re-runs when a support file in a skill changes", async () => {
    const { adapter, calls } = countingAdapter();
    const dir = cacheDir();
    const packDir = pack({ alpha: "does alpha" });
    writeFileSync(join(packDir, "alpha", "reference.md"), "v1");
    await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir });

    writeFileSync(join(packDir, "alpha", "reference.md"), "v2");
    await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir });

    expect(calls()).toBe(2);
  });

  it("reuses samples when only the corpus changes, so new gates rescore old samples", async () => {
    const { adapter, calls } = countingAdapter();
    const dir = cacheDir();
    const packDir = pack({ alpha: "does alpha" });
    mkdirSync(join(packDir, "alpha", "evals"));
    writeFileSync(join(packDir, "alpha", "evals", "triggers.yaml"), "gates: {trigger: 0.9}");
    await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir });

    writeFileSync(join(packDir, "alpha", "evals", "triggers.yaml"), "gates: {trigger: 0.5}");
    const outcome = await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir });

    expect(calls()).toBe(1);
    expect(outcome.cached).toBe(true);
  });

  it("re-runs when the agent version changes", async () => {
    const { adapter, calls } = countingAdapter();
    const dir = cacheDir();
    const packDir = pack({ alpha: "does alpha" });

    await new CachingAdapter({ ...adapter, version: () => Promise.resolve("1.0.0") }, dir).runPrompt({ prompt: "p", packDir });
    await new CachingAdapter({ ...adapter, version: () => Promise.resolve("1.0.1") }, dir).runPrompt({ prompt: "p", packDir });

    expect(calls()).toBe(2);
  });

  it("turns caching off when the agent version cannot be read", async () => {
    // Without a version, an upgraded CLI would be served answers recorded by the old one
    const { adapter, calls } = countingAdapter();
    const dir = cacheDir();
    const packDir = pack({ alpha: "does alpha" });
    const unknown = { ...adapter, version: () => Promise.reject(new Error("no --version")) };
    const warnings: string[] = [];

    await new CachingAdapter(unknown, dir, { warn: (m) => warnings.push(m) }).runPrompt({ prompt: "p", packDir });
    await new CachingAdapter(unknown, dir, { warn: (m) => warnings.push(m) }).runPrompt({ prompt: "p", packDir });

    expect(calls()).toBe(2);
    expect(warnings).toHaveLength(2);
  });

  it("re-runs when the timeout changes", async () => {
    const { adapter, calls } = countingAdapter();
    const dir = cacheDir();
    const packDir = pack({ alpha: "does alpha" });

    await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir, timeoutMs: 1000 });
    await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir, timeoutMs: 2000 });

    expect(calls()).toBe(2);
  });

  it("varies runs of the same prompt instead of replaying one answer", async () => {
    // Five identical cached answers would report a fake 100% or 0%; each repeat is its own entry.
    let call = 0;
    const adapter: AgentAdapter = {
      id: "alternating",
      runPrompt: () => {
        call += 1;
        return Promise.resolve({ invokedSkills: call % 2 === 0 ? [] : ["alpha"], usable: true, costUsd: 0.01 });
      },
    };
    const dir = cacheDir();
    const packDir = pack({ alpha: "does alpha" });
    const caching = new CachingAdapter(adapter, dir);

    const first = await caching.runPrompt({ prompt: "p", packDir });
    const second = await caching.runPrompt({ prompt: "p", packDir });

    expect(call).toBe(2);
    expect(first.invokedSkills).toEqual(["alpha"]);
    expect(second.invokedSkills).toEqual([]);
  });

  it("produces identical cache key for CRLF and LF line endings in SKILL.md", async () => {
    const { adapter, calls } = countingAdapter();
    const dir = cacheDir();

    const lfDir = mkdtempSync(join(tmpdir(), "skillcaller-lf-"));
    mkdirSync(join(lfDir, "alpha"), { recursive: true });
    writeFileSync(join(lfDir, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: test\n---\nbody\n");

    const crlfDir = mkdtempSync(join(tmpdir(), "skillcaller-crlf-"));
    mkdirSync(join(crlfDir, "alpha"), { recursive: true });
    writeFileSync(join(crlfDir, "alpha", "SKILL.md"), "---\r\nname: alpha\r\ndescription: test\r\n---\r\nbody\r\n");

    const first = await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir: lfDir });
    const second = await new CachingAdapter(adapter, dir).runPrompt({ prompt: "p", packDir: crlfDir });

    expect(calls()).toBe(1);
    expect(second.invokedSkills).toEqual(first.invokedSkills);
  });

  it("forwards close to the inner adapter", async () => {
    let closed = 0;
    const adapter: AgentAdapter = {
      id: "inner",
      runPrompt: () => Promise.resolve({ invokedSkills: [], usable: true, costUsd: 0 }),
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    };

    await new CachingAdapter(adapter, cacheDir()).close();

    expect(closed).toBe(1);
  });
});

