import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";

describe("FakeAdapter", () => {
  it("replays the scripted answers for a prompt in order", async () => {
    const adapter = new FakeAdapter({ p: [["alpha"], []] });

    expect((await adapter.runPrompt({ prompt: "p", packDir: "/pack" })).invokedSkills).toEqual(["alpha"]);
    expect((await adapter.runPrompt({ prompt: "p", packDir: "/pack" })).invokedSkills).toEqual([]);
  });

  it("cycles when asked for more runs than the script provides", async () => {
    const adapter = new FakeAdapter({ p: [["alpha"]] });

    await adapter.runPrompt({ prompt: "p", packDir: "/pack" });
    expect((await adapter.runPrompt({ prompt: "p", packDir: "/pack" })).invokedSkills).toEqual(["alpha"]);
  });

  it("treats an unscripted prompt as a usable run that invoked nothing", async () => {
    const outcome = await new FakeAdapter().runPrompt({ prompt: "unknown", packDir: "/pack" });

    expect(outcome).toEqual({ invokedSkills: [], usable: true, costUsd: 0 });
  });

  it("loads a script from a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skillcaller-fake-"));
    const file = join(dir, "script.json");
    writeFileSync(file, JSON.stringify({ p: [["beta"]] }));

    const adapter = FakeAdapter.fromFile(file);

    expect((await adapter.runPrompt({ prompt: "p", packDir: "/pack" })).invokedSkills).toEqual(["beta"]);
  });
});
