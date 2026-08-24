# Security policy

## Reporting a vulnerability

Report privately through GitHub's [security advisory form](https://github.com/iVamsi/skillcaller/security/advisories/new).
Expect an acknowledgement within 3 working days. Please do not open a public issue for a
vulnerability.

## What skillcaller does with untrusted input

A skill is Markdown written by someone else. skillcaller reads skills, hands them to an agent, and
watches which one the agent reaches for. The skill body is prompt-injection surface, so the
harness is built so that a skill's instructions cannot act:

- **Tools are refused.** Claude Code runs with every tool except `Skill` on the disallowed list, so
  a skill body cannot make the agent read, write, or execute anything. Codex runs with
  `--sandbox read-only`. Cursor runs with `--mode ask` (read-only mode). Antigravity CLI runs with
  `--sandbox`; workspace file reads are auto-allowed and shell stays Ask unless you pass
  `--dangerously-skip-permissions`, which is never passed.

  This is a denylist by necessity. `--allowed-tools` only auto-approves; tested against the real
  CLI, a prompt demanding Bash still invoked it when `--allowed-tools Skill` was the only
  restriction. `--disallowed-tools` does block execution, and the CLI answers such a call with
  "Bash is disabled for this session, in subagents as well as here". A tool absent from the list
  still runs, so the list covers the whole known surface, including delegation (`Task`, `Agent`,
  `ToolSearch`) and anything outward-facing (`Artifact`, `SendMessage`, `CronCreate`).

  Verified end to end: a skill whose body instructs the agent to `touch` a file triggers, and no
  file is created.
- **One turn only.** `--max-turns 1` stops the run at the point the decision is observable. A skill
  never gets a second turn to act on its own instructions.
- **Disposable workspaces.** Each run happens in a fresh temp directory that is deleted afterwards.
  Your repository is never the working directory.
- **No approval bypass.** `--dangerously-skip-permissions` and
  `--dangerously-bypass-approvals-and-sandbox` are never passed, and tests assert their absence.

## Isolation from your own skills

A personal skill can answer a prompt meant for the pack under test and silently corrupt a
measurement. Claude Code runs with `--setting-sources project`, which was verified to stop a
personal plugin skill from answering. Codex, Cursor, and Antigravity CLI read skills from your home
directory and offer no override that keeps authentication working, so those reads are surfaced as
contamination: they are never counted as hits, they appear in every report format, and they fail
the skill rather than letting a contaminated run look clean.

Antigravity CLI ignores workspace `.agents/skills`. Each run installs the pack as a uniquely named
plugin under `~/.gemini/config/plugins` and uninstalls it afterwards. A killed process can leave a
plugin whose name starts with `sc`; remove it with `agy plugin uninstall`.

The corpus never travels with the pack. `evals/triggers.yaml` lists the prompts that are supposed
to trigger a skill, and Codex can read files even under `--sandbox read-only`, so installing it
alongside `SKILL.md` would hand the agent the answer key to its own exam.

## Credentials

skillcaller never reads, stores, or logs credentials. It runs the agent CLIs you have already
authenticated and inherits their environment. Reports contain prompts and skill names, never
transcript bodies.

## Supply chain

- Dependencies are pinned exactly and the lockfile is committed.
- The package ships no install scripts, and CI installs with `--ignore-scripts`.
- GitHub Actions are pinned to commit SHAs.
- Releases publish from CI only, with npm trusted publishing and provenance attestation.
