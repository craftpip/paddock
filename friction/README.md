# MCP Friction Log

Friction that LLM clients hit while driving Paddock through the MCP surface
(`/mcp`). This is a **raw findings log**, not documentation: it records what a
caller could not understand, could not do, or had to guess — and what the fix
would be. Once a finding is fixed, the entry stays and gets a
**Resolution** line, so the history of what confused callers survives.

Business logic and the real reference for the tools live in `docs/`. Only
findings go here.

## How to add an entry

1. One file per chat-test session: `friction/YYYY-MM-DD-<slug>.md`.
2. Date is the day the session ran. The slug names the task, not the tool
   ("clone-proj", not "create-agent-bug").
3. Newest file last in the folder listing; no index to maintain.
4. One H3 per finding, in the shape below.

### Entry shape

```markdown
### <short title>

- **Tool:** `tool_name` (or `tool_a` + `tool_b`)
- **Severity:** blocker | guessing | noise
- **What I asked:** the request in one line
- **What happened:** what the tool returned, verbatim where it matters
- **Why it hurts:** the cost to a caller that has only the tool surface
- **Fix:** the smallest change that removes the guess
```

Severity meanings:

| Severity | Means |
|----------|-------|
| `blocker` | the caller cannot complete the task at all |
| `guessing` | the caller completes it, but had to infer a rule that wasn't stated |
| `noise` | the answer is right, but oversized or misleading alongside the truth |

## Entries

- `2026-09-27-clone-proj.md` — cloning `pad-opencode-proj` into a second pad.

## See Also

- [`docs/` reference](../docs/README.md) — how the tools actually work.
- [`AGENTS.md`](../AGENTS.md) — the "chat test" mode this log comes from.
