import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planPack } from "../../src/commands/plan.js";
import { loadPack } from "../../src/pack/load-pack.js";

function pack(): string {
  const dir = mkdtempSync(join(tmpdir(), "skillcaller-plan-"));
  for (const name of ["alpha", "beta"]) {
    mkdirSync(join(dir, name, "evals"), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n`);
  }
  writeFileSync(
    join(dir, "alpha", "evals", "triggers.yaml"),
    `skill: alpha\nruns: 3\ntimeout_ms: 5000\nshould_trigger: ["do alpha"]\nshould_not_trigger: ["do nothing"]\n`,
  );
  return dir;
}

describe("planPack", () => {
  it("lists what a run would do without calling an agent", () => {
    const plan = planPack(loadPack(pack()), { agent: "fake", concurrency: 2 });

    expect(plan.calls).toBe(6);
    expect(plan.unmeasured).toEqual(["beta"]);
    expect(plan.skills[0]).toMatchObject({ skill: "alpha", runs: 3, timeoutMs: 5000 });
    expect(plan.skills[0]?.cases.map((c) => c.expectation)).toEqual(["trigger", "no-trigger"]);
  });

  it("lets --timeout override the corpus timeout, as a run does", () => {
    const plan = planPack(loadPack(pack()), { agent: "fake", concurrency: 2, timeoutMs: 100 });

    expect(plan.skills[0]?.timeoutMs).toBe(100);
  });
});
