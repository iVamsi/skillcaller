import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliVersion, spawnCli } from "../adapters/spawn-cli.js";

export interface Check {
  readonly name: string;
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
}

export interface Capability {
  readonly name: string;
  readonly value: string;
  /** A recorded fixture or a document that backs the claim. */
  readonly evidence: string;
}

export interface Diagnosis {
  readonly agent: string;
  readonly ok: boolean;
  /** Every command the checks ran, so nothing runs that the user cannot see. */
  readonly probes: readonly string[];
  readonly checks: readonly Check[];
  readonly capabilities: readonly Capability[];
}

interface AgentProfile {
  readonly binary: string;
  readonly helpArgs: readonly string[];
  /** Flags the adapter passes; each should appear in the CLI's help. */
  readonly flags: readonly string[];
  readonly capabilities: readonly Capability[];
}

const SECURITY = "SECURITY.md";

export const AGENT_PROFILES: Readonly<Record<string, AgentProfile>> = {
  "claude-code": {
    binary: "claude",
    helpArgs: ["--help"],
    flags: ["--print", "--output-format", "--verbose", "--max-turns", "--disallowed-tools", "--setting-sources", "--model"],
    capabilities: [
      { name: "activation signal", value: "Skill tool call", evidence: "fixtures/claude-code/invoked.ndjson" },
      { name: "your own skills", value: "hidden by --setting-sources project", evidence: SECURITY },
      { name: "tool limit", value: "every tool except Skill disallowed", evidence: SECURITY },
      { name: "cost reporting", value: "reported per run", evidence: "fixtures/claude-code/invoked.ndjson" },
      { name: "cleanup", value: "temp workspace and process group removed", evidence: SECURITY },
    ],
  },
  codex: {
    binary: "codex",
    helpArgs: ["exec", "--help"],
    flags: ["--json", "--sandbox", "--skip-git-repo-check", "--model"],
    capabilities: [
      { name: "activation signal", value: "shell read of SKILL.md", evidence: "fixtures/codex/invoked.jsonl" },
      { name: "your own skills", value: "visible; reported as contamination", evidence: SECURITY },
      { name: "tool limit", value: "--sandbox read-only (not verified by skillcaller)", evidence: SECURITY },
      { name: "cost reporting", value: "none; runs are counted as unpriced", evidence: "fixtures/codex/invoked.jsonl" },
      { name: "cleanup", value: "temp workspace and process group removed", evidence: SECURITY },
    ],
  },
  cursor: {
    binary: "cursor-agent",
    helpArgs: ["--help"],
    flags: ["--output-format", "--workspace", "--trust", "--mode", "--model"],
    capabilities: [
      { name: "activation signal", value: "readToolCall on SKILL.md", evidence: "fixtures/cursor/invoked.ndjson" },
      { name: "your own skills", value: "visible; reported as contamination", evidence: SECURITY },
      { name: "tool limit", value: "--mode ask (not verified by skillcaller)", evidence: SECURITY },
      { name: "cost reporting", value: "none; runs are counted as unpriced", evidence: "fixtures/cursor/invoked.ndjson" },
      { name: "cleanup", value: "temp workspace and process group removed", evidence: SECURITY },
    ],
  },
  antigravity: {
    binary: "agy",
    helpArgs: ["--help"],
    flags: ["--output-format", "--sandbox", "--model"],
    capabilities: [
      { name: "activation signal", value: "view_file on SKILL.md", evidence: "fixtures/antigravity/invoked.ndjson" },
      { name: "your own skills", value: "visible; reported as contamination", evidence: SECURITY },
      { name: "tool limit", value: "--sandbox (not verified by skillcaller)", evidence: SECURITY },
      { name: "cost reporting", value: "none; runs are counted as unpriced", evidence: "fixtures/antigravity/invoked.ndjson" },
      { name: "cleanup", value: "plugin uninstalled and journaled; process group removed", evidence: SECURITY },
    ],
  },
};

const HELP_TIMEOUT_MS = 15_000;

/** Local checks only: no prompt is sent and nothing is installed. */
export async function diagnose(agent: string, binary?: string): Promise<Diagnosis> {
  const profile = AGENT_PROFILES[agent];
  if (profile === undefined) {
    throw new Error(`doctor checks ${Object.keys(AGENT_PROFILES).join(", ")}; got "${agent}"`);
  }
  const bin = binary ?? profile.binary;
  const probes = [`${bin} --version`];
  const checks: Check[] = [];

  try {
    checks.push({ name: "version", status: "ok", detail: await cliVersion(bin) });
  } catch (error) {
    checks.push({ name: "version", status: "fail", detail: (error as Error).message });
  }

  if (checks[0]?.status === "ok") {
    probes.push(`${bin} ${profile.helpArgs.join(" ")}`);
    const help = await spawnCli(bin, profile.helpArgs, { cwd: tmpdir(), timeoutMs: HELP_TIMEOUT_MS });
    const text = `${help.stdout}\n${help.stderr}`;
    const missing = profile.flags.filter((flag) => !text.includes(flag));
    checks.push(
      missing.length === 0
        ? { name: "flags", status: "ok", detail: "help lists every flag skillcaller passes" }
        : // Help text is not a contract, so a missing flag is a warning, not proof it is unsupported
          { name: "flags", status: "warn", detail: `not listed in help: ${missing.join(", ")}` },
    );
  }

  checks.push(tempDirCheck());
  return {
    agent,
    ok: checks.every((check) => check.status !== "fail"),
    probes,
    checks,
    capabilities: profile.capabilities,
  };
}

function tempDirCheck(): Check {
  try {
    rmSync(mkdtempSync(join(tmpdir(), "skillcaller-doctor-")), { recursive: true });
    return { name: "temp directory", status: "ok", detail: tmpdir() };
  } catch (error) {
    return { name: "temp directory", status: "fail", detail: (error as Error).message };
  }
}

export function renderDiagnosis(diagnosis: Diagnosis): string {
  const mark = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;
  return [
    `${diagnosis.agent}`,
    ...diagnosis.checks.map((check) => `  ${mark[check.status]}  ${check.name}: ${check.detail}`),
    "",
    "Capabilities:",
    ...diagnosis.capabilities.map((c) => `  ${c.name}: ${c.value} (${c.evidence})`),
    "",
    `Ran: ${diagnosis.probes.join("; ")}`,
  ].join("\n");
}
