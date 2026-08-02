# Coding-Agent Build Images + Docker Access Setting — Plan

## Status: Proposed (2026-08-02)

## Goal

Two things, both small:

1. **New agent build images** — OpenCode, Codex, Claude (Claude Code). Follow the
   exact same rules as the existing OpenClaw / PicoClaw / Hermes builds.
   **Nothing extra.** No MCP autoconfig, no harness page, no new magic.
2. **Per-agent Settings page** with one checkbox — *"Allow docker in the
   container"*. Toggling it stops the agent, edits the instance compose file to
   add/remove the docker socket volume mapping, then restarts the container.
   Docker MCP is set up from the existing MCP terminal and only needs the
   `docker` command in it.

## Part 1 — New build images

Follow the OpenClaw pattern exactly. Each new type gets:

- `src/vm-builds/<agent>/Dockerfile`
- an entry in `AGENT_IMAGES` + `AGENT_BUILD_REL` in `src/services/vm-manager.js`
- a `<option>` in the agent-type select on `CreateAgent.jsx`
- `meta.env` → `AGENT=<agent>`
- data dir `/root/.<agent>` — `containerDataDir()` already does this generically
  for non-hermes types, so `/root/.codex`, `/root/.opencode`, `/root/.claude`
  come free

### The three images

| Type | Base image | CLI install | Config dir |
|------|-----------|-------------|------------|
| `opencode` | `node:20-slim` | `npm i -g opencode-ai` | `/root/.opencode` |
| `codex` | `node:20-slim` | `npm i -g @openai/codex` | `/root/.codex` |
| `claude` | `node:20-slim` | `npm i -g @anthropic-ai/claude-code` | `/root/.claude` |

Each Dockerfile mirrors the openclaw one: sshd + `ROOT_PASSWORD` handling, TZ,
`mcporter`, `start.sh` (`sshd &` + keep-alive since these CLIs have **no gateway
daemon** — the terminal tab is the interface), `WORKDIR /root`, `EXPOSE 22`.
The agent CLI is run interactively from the terminal (`opencode` / `codex` /
`claude`), config persists in the mounted data dir.

Also bake in the **docker CLI** (see Part 2 — the checkbox only toggles the
socket mount, so the CLI must already exist in the image).

### createVm

No change needed: the `openclaw setup --baseline` + restart step is already
guarded to `openclaw` / `picoclaw` only. New types skip it automatically.

### Discovery

`agent-registry.js` already keys off `meta.AGENT` and finds the data dir
`instances/<name>/<agent>` — new types show up on the dashboard with the right
`agent_type` out of the box.

## Part 2 — Settings page: "Allow docker in the container"

### UI

A **Settings mode** on the agent page (new tab in the terminal-first layout,
next to Commands / Workspace / Config / Logs / Sessions / Activity). One
checkbox:

> **Allow docker in the container** — lets this agent run `docker` commands
> (docker CLI + host socket).

When the user toggles it **on**, show a confirm popup:

> "This will stop and restart `<name>` to apply the change. Continue?"

Same confirm when toggling off.

### Flow (backend)

`POST /api/agents/:name/settings` `{ allowDocker: boolean }`:

1. `docker stop <name>` (no-op if already stopped)
2. Edit the instance compose file — add/remove the volume mapping
   `/var/run/docker.sock:/var/run/docker.sock`
3. `docker start <name>`
4. Record activity, return the new state

Implementation: add `allowDocker` to `generateInstanceCompose()` /
`writeInstanceCompose()`. The settings route reads `meta.env` (agent, password,
port), regenerates the compose with the flag, then restarts. Compose files are
machine-generated here, so regenerating is the source of truth, not a fragile
string edit.

`GET /api/agents/:name/settings` returns `{ allowDocker }` — derived from
whether the current compose file has the socket mount (or from a stored flag in
meta.env, e.g. `DOCKER=1`). Storing it in meta.env is more robust than parsing
YAML.

### Guard rails

- Socket = host docker = root-equivalent. The confirm popup should say this.
- If the image has no docker CLI, the toggle errors with a hint ("image has no
  docker CLI — rebuild the image") instead of silently succeeding.
- Restart kills the running session — that's why the popup warns first.
- The checkbox lives on every agent type (openclaw PADs can use it too), but
  the docker CLI must exist in the image for it to mean anything. Only the new
  coding images get the CLI baked in for now.

## Part 3 — Docker MCP (from the MCP terminal)

No autoconfig. The user adds it manually through the existing MCP flow
(`openclaw mcp add` from the MCP commands in the terminal). The docker MCP only
needs the `docker` command in it:

- `openclaw mcp add docker -- npx -y mcp-server-docker`

(Verify the exact command against the current docs — docs.openclaw.ai.)

The MCP alone is useless without Part 2: no socket mount → no docker access.
So the settings checkbox is the real capability gate; the MCP is just how the
agent drives it.

## Files

- **New** `src/vm-builds/opencode/Dockerfile`
- **New** `src/vm-builds/codex/Dockerfile`
- **New** `src/vm-builds/claude/Dockerfile`
- **Modified** `src/services/vm-manager.js` — `AGENT_IMAGES`, `AGENT_BUILD_REL`,
  `generateInstanceCompose()` `allowDocker` option
- **Modified** `src/app.js` — `GET/POST /api/agents/:name/settings`
- **Modified** `src/client/src/pages/CreateAgent.jsx` — new type options
- **Modified** `src/client/src/pages/AgentDetail.jsx` — Settings mode + checkbox
  + confirm popup

## Phases

### Phase 1 — Build images
- Dockerfiles + maps + create-agent select options.
- Create one agent of each type; terminal drops into shell; `opencode --version`
  / `codex --version` / `claude --version` work; data dir persists across
  restart.

### Phase 2 — Settings checkbox
- `settings` endpoints + compose regeneration + stop/edit/start flow.
- Toggle on a test agent; verify socket mount and `docker ps` from inside;
  toggle off; verify mount gone.

### Phase 3 — Docker MCP
- Manual `openclaw mcp add` for docker on a coding agent with the checkbox on;
  confirm the tool works. Document the command in the MCP commands group.

## Verification

```bash
# build types
sudo bash add-vm.sh mycodex --agent codex       # or via web UI
docker exec mycodex opencode --version          # or codex / claude

# settings toggle on
curl -X POST http://localhost:5051/api/agents/mycodex/settings \
  -H "Authorization: ..." -d '{"allowDocker": true}'
docker inspect mycodex --format '{{range .Mounts}}{{.Source}} {{.Destination}}{{"\n"}}{{end}}'
# → /var/run/docker.sock /var/run/docker.sock
docker exec mycodex docker ps                    # works

# settings toggle off → mount gone, docker ps inside fails

# MCP: openclaw mcp add docker ... → tools/list shows docker tool
```

## Security & edge cases

| Case | Handling |
|------|----------|
| docker socket = host root | Prominent warning in the confirm popup |
| Image without docker CLI | Settings toggle errors with rebuild hint |
| Container already stopped | Skip stop, still edit + start |
| Restart kills session | Popup warns before toggling |
| Compose file hand-edited | Regeneration overwrites it — documented as machine-generated |

## Open questions

- **"Cloud" = Claude?** Naming the third type `claude` (`@anthropic-ai/claude-code`). Say the word if it meant something else.
- Bake docker CLI into the **openclaw** image too, or only the new coding images for now?
- Keep the settings state in `meta.env` (`DOCKER=1`) vs parsing the compose file?

## Related

- `terminal-first-ui.md` — the agent page modes this Settings mode slots into
- Existing builds: `src/vm-builds/{openclaw,picoclaw,hermes}/Dockerfile`
- `paddock-own-mcp.md` — unrelated to this; the harness idea was dropped
