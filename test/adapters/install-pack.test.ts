import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installPack } from "../../src/adapters/install-pack.js";

function pack(): { packDir: string; dest: string } {
  const packDir = mkdtempSync(join(tmpdir(), "skillcaller-install-pack-"));
  const dest = mkdtempSync(join(tmpdir(), "skillcaller-install-dest-"));
  mkdirSync(join(packDir, "alpha"));
  writeFileSync(join(packDir, "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
  mkdirSync(join(packDir, "alpha", "evals"));
  writeFileSync(join(packDir, "alpha", "evals", "triggers.yaml"), "skill: alpha\n");
  return { packDir, dest };
}

describe("installPack", () => {
  it("does not copy directories that are not skills", () => {
    // loadPack ignores dirs without SKILL.md; copying them would drop node_modules into the workspace
    const { packDir, dest } = pack();
    mkdirSync(join(packDir, "node_modules", "leftpad"), { recursive: true });
    writeFileSync(join(packDir, "node_modules", "leftpad", "index.js"), "module.exports=1\n");

    installPack(packDir, dest);

    expect(readdirSync(dest)).toEqual(["alpha"]);
    expect(existsSync(join(dest, "node_modules"))).toBe(false);
  });
});
