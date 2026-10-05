import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("copies skill files and skips corpus directories at every level", () => {
    const { packDir, dest } = pack();
    mkdirSync(join(packDir, "alpha", "notes", "evals"), { recursive: true });
    writeFileSync(join(packDir, "alpha", "notes", "guide.md"), "guide\n");
    writeFileSync(join(packDir, "alpha", "notes", "evals", "secret.txt"), "answer\n");

    installPack(packDir, dest);

    expect(existsSync(join(dest, "alpha", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dest, "alpha", "notes", "guide.md"))).toBe(true);
    expect(existsSync(join(dest, "alpha", "evals"))).toBe(false);
    expect(existsSync(join(dest, "alpha", "notes", "evals"))).toBe(false);
  });

  it("rejects a symlinked skill root", () => {
    const { packDir, dest } = pack();
    symlinkSync(join(packDir, "alpha"), join(packDir, "linked"));

    expect(() => installPack(packDir, dest)).toThrow(/linked: symlink/);
  });

  it("rejects a symlink to a file outside the pack", () => {
    const { packDir, dest } = pack();
    const outside = join(tmpdir(), `skillcaller-outside-${process.pid}`);
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(packDir, "alpha", "secret.md"));

    expect(() => installPack(packDir, dest)).toThrow(/secret\.md: symlink/);
    expect(existsSync(join(dest, "alpha", "secret.md"))).toBe(false);
  });

  it("rejects a nested symlink", () => {
    const { packDir, dest } = pack();
    const outside = join(tmpdir(), `skillcaller-nested-${process.pid}`);
    writeFileSync(outside, "secret");
    mkdirSync(join(packDir, "alpha", "docs"));
    symlinkSync(outside, join(packDir, "alpha", "docs", "secret.md"));

    expect(() => installPack(packDir, dest)).toThrow(/docs\/secret\.md: symlink/);
    expect(existsSync(join(dest, "alpha", "docs", "secret.md"))).toBe(false);
  });

  it("rejects a symlink to the excluded corpus", () => {
    const { packDir, dest } = pack();
    symlinkSync(join(packDir, "alpha", "evals"), join(packDir, "alpha", "leak"));

    expect(() => installPack(packDir, dest)).toThrow(/leak: symlink/);
    expect(existsSync(join(dest, "alpha", "leak"))).toBe(false);
    expect(existsSync(join(dest, "alpha", "evals"))).toBe(false);
  });

  it("rejects a symlink cycle instead of walking it", () => {
    const { packDir, dest } = pack();
    symlinkSync(join(packDir, "alpha"), join(packDir, "alpha", "loop"));

    expect(() => installPack(packDir, dest)).toThrow(/loop: symlink/);
  });

  it("rejects a special file", () => {
    const { packDir, dest } = pack();
    const fifo = join(packDir, "alpha", "pipe");
    const made = spawnSync("mkfifo", [fifo]);
    expect(made.status).toBe(0);

    expect(() => installPack(packDir, dest)).toThrow(/pipe: not a regular file/);
    expect(existsSync(join(dest, "alpha", "pipe"))).toBe(false);
  });

  it("rejects a symlinked SKILL.md", () => {
    const { packDir, dest } = pack();
    const body = join(packDir, "alpha", "body.md");
    writeFileSync(body, "---\nname: alpha\n---\n");
    rmSync(join(packDir, "alpha", "SKILL.md"));
    symlinkSync(body, join(packDir, "alpha", "SKILL.md"));

    expect(() => installPack(packDir, dest)).toThrow(/SKILL.md: symlink/);
  });

  it("refuses a pack too large to be a set of skills", () => {
    const { packDir, dest } = pack();
    writeFileSync(join(packDir, "alpha", "huge.bin"), Buffer.alloc(11 * 1024 * 1024));

    expect(() => installPack(packDir, dest)).toThrow(/larger than/);
  });

  it("refuses a pack with too many files", () => {
    const { packDir, dest } = pack();
    for (let i = 0; i < 1001; i++) writeFileSync(join(packDir, "alpha", `f${i}.md`), "");

    expect(() => installPack(packDir, dest)).toThrow(/more than 1000 files/);
  });
});
