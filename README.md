# skillcaller

[![CI](https://github.com/iVamsi/skillcaller/actions/workflows/ci.yml/badge.svg)](https://github.com/iVamsi/skillcaller/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.scorecard.dev%2Fprojects%2Fgithub.com%2FiVamsi%2Fskillcaller&query=%24.score&label=OpenSSF%20Scorecard)](https://scorecard.dev/viewer/?uri=github.com/iVamsi/skillcaller)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green.svg)](package.json)

Trigger-reliability evals for [Agent Skills](https://agentskills.io). Proves your skills fire when
they should, stay silent when they shouldn't, and don't steal each other's prompts.

```bash
npx skillcaller run
```

```
PASS  writing-compose-previews  triggers 100%  false triggers 0%
FAIL  writing-compose-ui        triggers 80%  false triggers 0%
      - trigger rate 80% is below the gate of 90%

Collisions (another skill answered these prompts):
  writing-compose-ui -> answered by writing-compose-previews 20% of the time

1 of 2 skill(s) failed.  cost $0.31
```

## Quick start

### 1. Installation

Run directly with `npx` (no installation required), or add it to your project:

```bash
# Run directly:
npx skillcaller run

# Or install as a development dependency:
npm install -D skillcaller
```

### 2. Where skills live (Auto-discovery)

`skillcaller` zero-configures by auto-detecting skills in any of these standard directories:
- `./skills` (general project skills)
- `.agents/skills` (standard Agent Skills directory for Cursor & Codex)
- `.claude/skills` (Claude Code directory)
- `.cursor/skills` (Cursor directory)

You can also pass any custom directory path explicitly:

```bash
npx skillcaller run path/to/my-skills
```

### 3. Step-by-step setup

#### Step A: Scaffold an eval corpus for a skill

```bash
npx skillcaller init skills/my-skill
```

This creates `skills/my-skill/evals/triggers.yaml` next to your `SKILL.md`.

#### Step B: Define your trigger expectations

```yaml
# skills/my-skill/evals/triggers.yaml
skill: my-skill
runs: 5          # activation is a rate, so one run proves nothing
gates:
  trigger: 0.9      # must trigger on >= 90% of expected queries
  no_trigger: 0.05  # must false-trigger on <= 5% of unrelated queries

# Phrasings a user would type, including error symptoms:
should_trigger:
  - "help me with my-skill"
  - "why does Res.string fail to resolve in commonMain?"

# Adjacent work this skill must stay out of:
should_not_trigger:
  - "rename this variable"
  - "write a kotlin extension function for lists"
```

#### Step C: Run the evaluation

```bash
# Run against Claude Code (default):
npx skillcaller run

# Run against Cursor Agent:
npx skillcaller run --agent cursor

# Run against Codex:
npx skillcaller run --agent codex

# Run against Antigravity CLI:
npx skillcaller run --agent antigravity

# Fast offline test against the fake scripted agent (used in CI):
npx skillcaller run examples/mini-pack --agent fake --script examples/mini-pack/fake-script.json
```

---

## Why

A skill that never triggers is documentation nobody reads. The measurements are not encouraging:

- Vercel's January 2026 agent evals found skills **went uninvoked in 56% of cases** even though the
  agent had them installed ([writeup](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals)).
- Community evals put activation at **37% for the passive description style** the docs suggest,
  versus **100% for a directive one**. The description is the trigger, and it is untested prose.
- Microsoft's skill-evaluation work reports **negative transfer in ~25% of cases** — a skill that
  loads can make the answer worse, and you cannot tell which by reading it.

Installing a skill tells you nothing about whether it works. skillcaller measures it.

## How it works

`skillcaller run` executes every prompt `runs` times against a real agent in a disposable
workspace, watches which skill the agent reaches for, and fails the build when a gate is missed.
Exit code 1 makes it a CI check, and every report format carries the same verdict, so a job
keyed on the JSON or JUnit file cannot disagree with the exit code.

Gates are strict by design, and the arithmetic is worth knowing before you set `runs`. At the
default 5 runs, a 0.9 trigger gate needs 5 out of 5, because 4 out of 5 is 80%. A 0.05
false-trigger gate means a single unwanted invocation (20%) fails. These are pass/fail thresholds
for CI, not confidence intervals: raise `runs` if you want a finer-grained estimate.

If the agent reaches a skill from outside the pack, the run is reported as contaminated and the
skill fails. A measurement taken in someone's personal skill library is not a measurement of your
pack.

### Collisions

In a pack of a dozen skills, the failure that hides best is two overlapping descriptions trading
invocations. skillcaller cross-tabulates every skill's prompts against every skill that answered
them, so an ambiguous description is named rather than guessed at. It costs no extra agent calls:
the matrix is built from runs already made.

## Commands

| Command | What it does |
| --- | --- |
| `skillcaller run [pack]` | Measure activation, enforce gates, report collisions (auto-detects standard dirs if omitted) |
| `skillcaller init <skill-dir>` | Scaffold an `evals/triggers.yaml` for a skill |

### Useful CLI Flags

| Flag | Description | Default |
| --- | --- | --- |
| `-a, --agent <agent>` | Agent engine: `claude-code`, `codex`, `cursor`, `antigravity`, `fake` | `claude-code` |
| `-m, --model <model>` | Model to evaluate against | `claude-haiku-4-5-20251001` (for claude-code) |
| `-c, --concurrency <n>` | Parallel agent runs | `2` |
| `-t, --timeout <ms>` | Per-prompt timeout in milliseconds | agent default (120000-180000ms) |
| `-f, --format <format>` | Output format: `terminal`, `markdown`, `json`, `junit` | `terminal` |
| `--collision-threshold <rate>` | Report a collision at or above this invocation rate | `0.2` |
| `--no-cache` | Re-run every prompt instead of reusing cached answers | `false` |
| `--cache-dir <dir>` | Directory where cached answers live | `.skillcaller-cache` |
| `--script <file>` | Path to scripted responses for the `fake` agent | (none) |

## CI Integration (GitHub Actions)

Add skill evaluation to your pull requests to stop trigger regressions:

```yaml
# .github/workflows/skills-eval.yml
name: Skills Eval

on:
  pull_request:
    paths:
      - 'skills/**'
      - '.agents/skills/**'

jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx skillcaller run --format junit > results.xml
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Agent support

| Agent | Detection signal | Isolation from your own skills | Status |
| --- | --- | --- | --- |
| **Claude Code** | `Skill` tool call in `--output-format stream-json` | Verified: `--setting-sources project` stops personal plugin skills answering | Supported, live-tested |
| **Codex** | reads `SKILL.md` with a shell command (no Skill tool) in `codex exec --json` | Partial: Codex also reads `~/.agents/skills`; `CODEX_HOME` carries auth so it cannot be redirected. Foreign reads are reported as contamination | Supported, live-tested |
| **Cursor** | `readToolCall` on `SKILL.md` in `cursor-agent -p --output-format stream-json` | `--mode ask` keeps runs read-only; skills from `~/.cursor/skills` or `~/.agents/skills` are reported as contamination | Supported, live-tested |
| **Antigravity** | `view_file` on `SKILL.md` in `agy -p --output-format stream-json` | Partial: workspace `.agents/skills` is ignored. The pack is installed as a temporary plugin under `~/.gemini/config/plugins` and removed after the run. Skills already in `~/.gemini/config/skills` stay visible; those reads are reported as contamination. Redirecting `HOME` breaks auth | Supported, live-tested |
| `fake` | scripted | total | For CI and for testing skillcaller itself |

Every adapter was written against a recording of the real CLI, committed under `fixtures/`. None
were written from documentation alone — the Codex and Cursor signals in particular are nothing like
the docs would have implied. The Antigravity IDE `agentapi` binary is not used: it only talks to a
running editor through `ANTIGRAVITY_LS_ADDRESS`. The adapter drives the CLI (`agy`) instead.

## Cost

Measurement costs tokens. A Claude Code run of one prompt measured **$0.017** with
`claude-haiku-4-5` (the default), down from $0.061 before isolation, because the system prompt no
longer carries every installed skill's metadata. A 20-prompt corpus at 5 runs is roughly $1.70.

Answers are cached, so iterating on one skill does not re-buy the rest. A measured example: a
two-skill pack cost **$0.24** cold and **$0.00** warm, finishing in 3.8s instead of 14.7s.

The cache key covers the **whole pack**, not one skill, because skills compete for a prompt and a
rival's new description can change this skill's result. Editing any description re-runs what it
affects. Unusable runs are never cached, since an auth failure is not a verdict. Disable it with
`--no-cache`.

## Security

Skill bodies are untrusted text. Tools are disallowed, turns are capped at one, workspaces are
disposable, and approval-bypass flags are never used. See [SECURITY.md](SECURITY.md).

## Contributing

Recordings of agent CLIs behaving unexpectedly are the most useful contribution. See
[CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md).

## License

```
Copyright 2026 Vamsi Vaddavalli

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    https://www.apache.org/licenses/LICENSE-2.0
```
