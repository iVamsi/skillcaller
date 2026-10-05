# Security policy

## Reporting a vulnerability

Report privately through GitHub's [security advisory form](https://github.com/iVamsi/skillcaller/security/advisories/new).
Expect an acknowledgement within 3 working days. Please do not open a public issue for a
vulnerability.

## What skillcaller does with untrusted input

A skill is Markdown written by someone else. skillcaller reads skills, hands them to an agent, and
watches which one the agent reaches for. The skill body is prompt-injection surface. skillcaller
limits what an agent may do while it decides, but the limits differ by agent, and the agent CLI
enforces them, not skillcaller. Treat a pack you did not write as you would any untrusted input.

### What each agent is allowed to do

| | Claude Code | Codex | Cursor | Antigravity |
| --- | --- | --- | --- | --- |
| Tool limit | Every tool except `Skill` is on `--disallowed-tools` (verified live) | `--sandbox read-only` (flag passed; not verified by skillcaller) | `--mode ask`, read-only (flag passed; not verified by skillcaller) | `--sandbox`; shell stays Ask (flag passed; not verified by skillcaller) |
| Turn limit | `--max-turns 1` | None | None | None |
| Your own skills | Hidden by `--setting-sources project` (verified live) | Visible; reads are reported as contamination | Visible; reads are reported as contamination | Visible; reads are reported as contamination |
| Filesystem | Fresh temp workspace, deleted after the run | Fresh temp workspace, deleted after the run | Fresh temp workspace, deleted after the run | Fresh temp workspace; the pack is a plugin under `~/.gemini/config/plugins` |
| Network | Not restricted by skillcaller; `WebFetch` and `WebSearch` are disallowed | Not restricted by skillcaller | Not restricted by skillcaller | Not restricted by skillcaller |
| Environment and credentials | Inherits yours | Inherits yours | Inherits yours | Inherits yours |

A temp workspace is not a filesystem boundary. An agent that can read files can read outside it,
which is why the tool limit matters more than the workspace.

Claude Code's tool limit is a denylist by necessity. `--allowed-tools` only auto-approves; tested
against the real CLI, a prompt demanding Bash still invoked it when `--allowed-tools Skill` was the
only restriction. `--disallowed-tools` does block execution, and the CLI answers such a call with
"Bash is disabled for this session, in subagents as well as here". A tool absent from the list
still runs, so the list covers the whole known surface, including delegation (`Task`, `Agent`,
`ToolSearch`) and anything outward-facing (`Artifact`, `SendMessage`, `CronCreate`). Verified end
to end: a skill whose body instructs the agent to `touch` a file triggers, and no file is created.
A new CLI release can add tools, so this holds for the versions tested, not every version.

`--dangerously-skip-permissions` and `--dangerously-bypass-approvals-and-sandbox` are never
passed, and tests assert their absence.

### Isolation from your own skills

A personal skill can answer a prompt meant for the pack under test and silently corrupt a
measurement. Codex, Cursor, and Antigravity CLI read skills from your home directory and offer no
override that keeps authentication working, so those reads are reported as contamination. They are
never counted as hits, they appear in every report format, and they fail the skill.

The corpus never travels with the pack. `evals/triggers.yaml` lists the prompts that are supposed
to trigger a skill, and Codex can read files even under `--sandbox read-only`, so installing it
alongside `SKILL.md` would hand the agent the answer key to its own exam.

### Processes and cleanup

Each agent runs in its own process group. On timeout, `--deadline`, `--max-cost`, Ctrl-C, or a
normal exit, skillcaller kills the whole group, so a process the agent started cannot outlive the
run. Process groups are POSIX only; on Windows only the agent process itself is killed, and Windows
is not a supported platform.

Antigravity CLI ignores workspace `.agents/skills`, so a run installs the pack as a uniquely named
plugin. skillcaller records the plugin name in a temp-directory journal before installing, and
deletes the record only after `agy plugin uninstall` succeeds. If the uninstall fails, the run fails
and prints the exact command to run. If skillcaller is killed before it can clean up, the next
Antigravity run removes plugins whose recorded owner process has exited, by their exact recorded
name.

## Credentials

skillcaller never reads, stores, or logs credentials. It runs the agent CLIs you have already
authenticated, and those CLIs inherit your environment. Reports contain your prompts, skill names,
and short failure reasons with token-like strings masked, never transcript bodies. Treat a report
as you would the corpus it came from.

## Supply chain

- Dependencies are pinned exactly and the lockfile is committed.
- The package ships no install scripts, and CI installs with `--ignore-scripts`.
- GitHub Actions are pinned to commit SHAs.
- Releases publish from CI only, with npm trusted publishing and provenance attestation.
