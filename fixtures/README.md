# Fixtures

Real recordings of agent CLIs, not hand-written samples. Every adapter and parser in this
repository was built against these rather than against documentation.

- `claude-code/invoked.ndjson` — `claude -p --output-format stream-json` where the agent invoked a
  skill. Shows the `tool_use` block named `Skill` that detection keys on.
- `claude-code/not-logged-in.ndjson` — the same command without credentials. The agent answers in
  prose instead of failing, which is why an unauthenticated run has to be marked unusable rather
  than scored as a missed trigger.
- `codex/invoked.jsonl` — `codex exec --json`. Codex has no Skill tool: it reads `SKILL.md` with a
  shell command, and this recording also caught it reading a skill from outside the pack.
- `cursor/invoked.ndjson` — `cursor-agent -p --output-format stream-json`. Cursor reads `SKILL.md`
  via `readToolCall` inside `.cursor/skills` or `.agents/skills`.
- `antigravity/invoked.ndjson` — `agy -p --output-format stream-json`. Workspace `.agents/skills`
  did not load. After `agy plugin install`, activation is `view_file` with `AbsolutePath` ending in
  `SKILL.md`. Tool lists and machine paths are redacted.

Recordings are redacted, not edited: machine paths, account details, and fields describing the
recording machine (installed MCP servers, tool lists, session hooks) are removed. The event shapes
and the values detection depends on are exactly as the CLIs emitted them.
