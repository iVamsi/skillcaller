# Contributing

Thanks for looking. The most useful contributions here are evidence: a recording of an agent CLI
doing something the parsers get wrong, or a prompt corpus that exposes a gap.

## Ground rules

**Adapters are written from recordings, never from documentation.** Every parser in this repository
was built against real CLI output committed under `fixtures/`. A pull request that adds or changes
an adapter needs a recording to justify it. Documentation has been wrong here before: Codex has no
Skill tool at all, which no amount of reading would have told us.

**Redact recordings before committing them.** A transcript carries the machine it came from.
Strip account details, connected MCP servers, installed skill lists, session hooks, and the bodies
of any third-party skills the agent opened. See `fixtures/README.md` for what was removed from the
existing ones and why.

**Tests come first.** Write the failing test, watch it fail for the reason you expect, then make it
pass. Two cache bugs in this repository were found only because a live run behaved differently from
a green unit test, and both now have regression tests.

## Getting set up

```bash
npm ci --ignore-scripts
npm test          # unit and golden tests; no network, no API key, no cost
npm run typecheck
npm run build
```

The whole pipeline runs offline against the fake agent:

```bash
node dist/cli.js run examples/mini-pack --agent fake --script examples/mini-pack/fake-script.json
```

Live tests spawn real agent CLIs and spend real tokens, so they are opt-in:

```bash
LIVE=1 npm run smoke
```

## What a good pull request looks like

- One concern per pull request.
- Tests for the behaviour you changed, including the failure mode.
- Coverage stays at or above 80%.
- No new runtime dependency without saying in the description why it earns its place.
- Commit messages say what changed and why, in plain sentences.

## Adding support for another agent

1. Install and authenticate the CLI.
2. Run it headless with a known skill installed and capture the raw event output.
3. Identify the deterministic signal that says a skill was invoked. If there isn't one, say so in
   the README compatibility table rather than guessing at a protocol.
4. Commit the redacted recording as a fixture, then write the parser and adapter against it.
5. Add a live smoke test that skips when the CLI is absent.

## Adding a tool to the deny list

`DISALLOWED_TOOLS` in `src/adapters/claude-code.ts` is a denylist because the CLI's allowlist flag
does not restrict anything. A tool missing from it will run. When an agent CLI gains a tool that
touches the filesystem, the network, another agent, or anything outside the session, add it and
extend the assertion in `test/adapters/claude-code.test.ts`.

## Reporting a vulnerability

Please use the process in [SECURITY.md](SECURITY.md), not a public issue.
