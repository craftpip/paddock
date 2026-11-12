# Plan 127 — Orchestrator chat test: Paddock develops Paddock, blockers answered over MCP

## Status: In progress (2026-11-13) — 1/5 phases done (setup). Next: restart Claude Code so the `paddock` MCP tools load, then run Phase 2 as the orchestrator.

## What the user asked (2026-11-13, verbatim intent)

"Add plans, test it again, test all scenarios during web development, test it by creating a
project in itself. Add plans for it, and those plans should need input which the pad will ask,
that will then be answered by an agent who is using the paddock MCP, and the pad should continue
working then. Add the paddock MCP to your harness; you simulate being the orchestrator of the
projects. The orchestrator will only have the MCP tools to work with, so the tools should be
nicely made for the LLM to understand."

## Roles

- **Worker:** the opencode TUI in `pad-dev`, driven by an infinite runner.
- **Orchestrator:** Claude Code, using ONLY the `paddock` MCP tools (chat-test rules in
  AGENTS.md: no bash/curl/node/backend tricks while acting as orchestrator; friction is logged,
  not worked around). The human may set up things the MCP genuinely cannot do; each such step is
  itself a friction finding.

## Setup (done 2026-11-13)

- [x] API key `orchestrator` (id `key_e0a5b022a27b6497`), scopes
  `tools:create,tools:exec,target:agent:pad-dev` — least privilege for this run.
- [x] `claude mcp add --transport http -s local paddock http://10.69.1.131:6789/mcp` with the
  key as a Bearer header (local scope, `~/.claude.json`, not committed). `claude mcp list` shows
  it connected; 39 tools for this key. **Tools load only at Claude Code startup: restart.**
- [x] "A project in itself": a clone of this repo at
  `pad-dev:/root/.opencode/workspace/paddock-self` (host
  `instances/pad-dev/opencode/workspace/paddock-self`), `origin` removed, so the worker edits
  real Paddock web code without touching the live source the webui runs from.
- Known before starting: no MCP tool creates a runner or presses Run/Pause (tool list:
  `agent_queue_*`, `queue_*`, `plan_*`, `mission_*`). Expected friction finding #1 — do not fix
  before the run.

## Phase 2 — the orchestrator run (MCP only)

1. `help` → read the guide as a first-time LLM.
2. Find `pad-dev`; create Mission project `paddock-self` at
   `/root/.opencode/workspace/paddock-self` (`mission_project_create`).
3. Write three small web-dev plans with `plan_write`, each of which REQUIRES a human decision
   the worker must ask for (mark the item `need_input` with the question, then stop):
   - `self-01-footer-version.md` — show the app version in the sidebar footer; must ask which
     source (package.json version vs git short sha).
   - `self-02-empty-state-copy.md` — rewrite the Mission col-2 empty state; must ask for the tone
     (terse vs friendly) before writing.
   - `self-03-queue-shortcut.md` — add a keyboard shortcut to open the queue; must ask which key.
   Each plan says: make the change in the code, run no installs, write what changed into the plan
   file, mark done.
4. Put them on a runner queue and start it — with MCP only if a tool exists; otherwise record the
   friction and have the human press Run in the UI (screenshot-free: name the button).
5. Loop as orchestrator: poll (`mission_sessions` / `agent_queue_read`), detect each blocker,
   answer it with `agent_queue_resolve_need_input`, verify the worker continued (item moves to
   `in progress` then `done`, the store shows the answer as the newest input).
6. Finish: all three `done`; diff in the clone shows the three changes.

## Phase 3 — friction log

`friction/2026-11-13-orchestrator-self-project.md`, one H3 per finding, severity per
`friction/README.md`: what the tool said, what an LLM had to guess, what was missing.

## Phase 4 — fix the tools

Fix every High/Medium finding in `src/mcp.js` / `services/llm-guide.js` (likely: runner create /
start / pause tools; clearer blocker discovery), with unit tests. Re-run Phase 2's loop for the
fixed parts.

## Phase 5 — close

Docs updated, plan absorbed and deleted, key `orchestrator` kept or revoked per the user.

- [x] Phase 1 setup
- [ ] Phase 2 orchestrator run
- [ ] Phase 3 friction log
- [ ] Phase 4 tool fixes
- [ ] Phase 5 close
