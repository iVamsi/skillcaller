# skillcaller

[![CI](https://github.com/iVamsi/skillcaller/actions/workflows/ci.yml/badge.svg)](https://github.com/iVamsi/skillcaller/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/iVamsi/skillcaller/badge)](https://scorecard.dev/viewer/?uri=github.com/iVamsi/skillcaller)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green.svg)](package.json)

Trigger-reliability evals for [Agent Skills](https://agentskills.io). Proves your skills fire when
they should, stay silent when they shouldn't, and don't steal each other's prompts.

```bash
npx skillcaller run ./skills
```

```
PASS  writing-compose-previews  triggers 100%  false triggers 0%
FAIL  writing-compose-ui        triggers 80%  false triggers 0%
      - trigger rate 80% is below the gate of 90%

Collisions (another skill answered these prompts):
  writing-compose-ui -> answered by writing-compose-previews 20% of the time

1 of 2 skill(s) failed.  cost $0.31
```

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

Each skill ships a corpus of prompts next to it:

```yaml
# skills/building-cmp-uis/evals/triggers.yaml
skill: building-cmp-uis
runs: 5          # activation is a rate, so one run proves nothing
gates:
  trigger: 0.9
  no_trigger: 0.05

should_trigger:
  - "add a compose multiplatform screen for settings"
  - "why does Res.string fail to resolve in commonMain?"   # symptoms trigger too
should_not_trigger:
  - "write a kotlin extension function for lists"          # a sibling skill's territory
```

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
| `skillcaller run <pack>` | Measure activation, enforce gates, report collisions |
| `skillcaller init <skill-dir>` | Scaffold an `evals/triggers.yaml` |

Useful flags: `--agent`, `--model`, `--concurrency`, `--format terminal\|json\|markdown\|junit`,
`--collision-threshold`.

## Agent support

| Agent | Detection signal | Isolation from your own skills | Status |
| --- | --- | --- | --- |
| **Claude Code** | `Skill` tool call in `--output-format stream-json` | Verified: `--setting-sources project` stops personal plugin skills answering | Supported, live-tested |
| **Codex** | reads `SKILL.md` with a shell command (no Skill tool) in `codex exec --json` | Partial: Codex also reads `~/.agents/skills`; `CODEX_HOME` carries auth so it cannot be redirected. Foreign reads are reported as contamination | Supported, live-tested |
| **Cursor** | `readToolCall` on `SKILL.md` in `cursor-agent -p --output-format stream-json` | `--mode ask` keeps runs read-only; skills from `~/.cursor/skills` or `~/.agents/skills` are reported as contamination | Supported, live-tested |
| **Antigravity** | unverified | n/a | Not implemented. Antigravity supports skills (source directories are listed in `~/.gemini/antigravity/skills.txt`), but ships no standalone headless CLI. Its `agentapi` binary is an IPC client to the running IDE: `new-conversation` fails with `ANTIGRAVITY_LS_ADDRESS is not set`, and that address appears in no config file. See below |
| `fake` | scripted | total | For CI and for testing skillcaller itself |

Every adapter was written against a recording of the real CLI, committed under `fixtures/`. None
were written from documentation alone — the Codex and Cursor signals in particular are nothing like
the docs would have implied.

### What would unblock Antigravity

Antigravity needs a headless entry point. `agentapi new-conversation` looks like one, but it
only talks to a live IDE instance through `ANTIGRAVITY_LS_ADDRESS`. If that variable is exported
into Antigravity's integrated terminal, running `echo $ANTIGRAVITY_LS_ADDRESS` there would confirm
it and make the adapter possible; otherwise it would mean depending on an undocumented internal
protocol, which is a worse foundation than saying "not supported".

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

Apache-2.0
