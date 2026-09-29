const { getLlmCatalog } = require('./drivers');

/** The general "how to use Paddock" guide (§§1–4 of plan 35a) served to the
 *  LLM over MCP. Read-only text, versioned with the code. The per-agent-type
 *  non-interactive command catalog (§5) is built on demand by getLlmCatalog
 *  and served by the `agent_commands` MCP tool. */
const GENERAL_GUIDE = `# How to use Paddock through MCP

You are driving **Paddock**, a management dashboard ("control plane") for a fleet of
**agent containers (PADs)**. Each PAD runs one agent of a type — openclaw, opencode,
picoclaw, hermes, codex, or claude. Paddock manages each PAD's lifecycle, config,
workspace, web publishing, SSH, extra ports, and health.

## The boundary

The MCP tools control **Paddock** (the fleet, the containers). Configuration *inside* a
container is the agent's own business — normally done by the user in the terminal, and by
you through the \`exec\` tool. Use \`exec\` for in-container commands (\`openclaw ...\`,
\`opencode ...\`, \`hermes ...\`, \`codex ...\`, \`claude ...\`, \`picoclaw ...\`).

## The tool surface

**Read / inspect:** \`list_agents\` (fleet summary), \`get_agent\` (full object, optional
logs tail), \`agent_logs\` (standalone container logs), \`config_get\` (driver config file,
**secrets redacted in both \`config\` and \`configRaw\`**), \`settings_get\` (the ONE read
tool — full picture before any change), \`health\` (declared-vs-live checkup, works on
stopped containers), \`workspace_write\` (write a workspace file — see the refusal note
below), \`plan_list\` / \`plan_write\` / \`plan_activity\` (the plan facility — see **Plans**).

**Control:** \`create_agent\`, \`start_agent\` / \`stop_agent\` / \`restart_agent\`, \`recreate\`
(the single mutation gun), \`update\` (alias for \`recreate {pull:true}\`), \`delete_agent\`.

**Job progress:** \`job_status\` / \`job_log\` (read) — the progress + build log of a
\`create_agent\` / \`recreate\` / \`update\`. A timed-out call does NOT cancel the work: the
image build keeps going in the background, so after a timeout poll \`job_status\` (or
\`job_log\`) with the pad name instead of retrying the mutation. Jobs are in-memory and
expire 5 minutes after they finish.

**Exec:** \`exec\` runs any shell command inside a PAD (\`docker exec -i sh -lc\`) — the vehicle
for agent-config commands (models, MCP servers, skills, ...). Optional \`stdin\` is written
verbatim to the process stdin; use it for secrets, never put secrets in the command text.

**Mission (the shared workplace):** on the coding agents (opencode, codex, claude) a
**project** is a (PAD, folder) pair and a **session** is a live agent TUI in that folder —
the unit of work, and the only place work happens where the human can watch it. There is
no headless path: if you want to work, you work in a session.
\`mission_projects\` / \`mission_sessions\` (read) let you see the human's projects and
sessions — with \`mission_sessions {session_id}\` you also get the tail of what that TUI is
showing RIGHT NOW, so you know what they are doing without asking. Every row also says
whether a turn is \`busy\` (streaming right now), so you can wait your turn instead of
interrupting. \`mission_project_create\` (create bucket) adds a project row; \`mission_session_start\`
and \`mission_send\` (exec bucket) open a session and type into one. A dead session is not a
dead end: \`mission_session_restart\` (pane gone) and \`mission_session_relaunch\` (pane
alive, TUI exited) bring it back on the SAME row and the same conversation, and
\`mission_session_close\` ends one deliberately. All are scoped to the PADs your key
may see.

## Caller rules — read this before mutating anything

- **Read-tool discipline:** run \`settings_get\` first. It returns everything (settings, ssh,
  workspace mount, volumes/ports, image/version, networkHealth, web publish state,
  availableNetworks). Reconstruct the picture before changing anything. Its
  \`availableNetworks\` is filtered to running peer candidates and capped at 10 — read
  \`availableNetworksTotal\` / \`availableNetworksTruncated\` to know if that is all of them.
  \`workspaceDevcontainer\` describes the workspace's own .devcontainer (shared with the
  pads in \`sharedWith\`), NOT this pad's config.
- **Change only what you specify:** \`recreate\` leaves every unspecified option untouched.
  \`undefined\` = keep; \`[]\` / \`''\` / \`false\` = explicit clear. Never default an option.
- **Naming:** \`create_agent\` takes the FINAL pad name with the container prefix left off;
  Paddock prepends \`CONTAINER_PREFIX\` (\`pad-\`) and never weaves in the agent type.
  \`name: "tester"\` → \`pad-tester\`, NOT \`pad-opencode-tester\`. Use the returned
  \`resolvedName\` in every later call.
- **Never retry a timed-out mutation:** the work continues in the background. Read
  \`job_status\` / \`job_log\` — a second \`create_agent\` would race the first build.
- **confirm-gated tools:** \`create_agent\` and \`delete_agent\` require \`confirm: true\`, and
  \`recreate\` requires it when \`reset: true\`. Only pass it after checking with the user.
- **No TTY in \`exec\`:** commands that demand a TTY (\`openclaw onboard\`,
  \`openclaw configure --section model\`, \`openclaw models auth login\`) hang or fail. Use the
  non-interactive alternatives from \`agent_commands\`, or ask the user to run them.
- **Write-only secrets:** \`sshPassword\` / web \`password\` are never returned by any read
  tool; an empty string means "keep current". Never echo them back. That covers the
  web app's **token** too: \`get_agent\` reports \`web.tokenConfigured\` and
  \`settings_get\` reports \`web.tokenConfigured\` / \`passwordConfigured\` — the values
  themselves (and the \`startCommand\` that bakes the password in) are never returned.
- **Never expose secrets:** \`config_get\` REDACTS every credential — anything under a
  \`headers\` map, and any authorization / api_key / token / secret / password / \`*-key\`
  key at any depth, in both \`config\` and \`configRaw\`. \`[REDACTED]\` is not a value you
  can use: to *use* a secret, run the agent's own command through \`exec\` with the
  secret on \`stdin\`, never through a read tool, and never paste a key into a prompt.
- **No \`paddock_\` prefix** on tool names — the client namespaces them itself.
- **Verification habit:** after any mutation, re-run the matching read tool
  (\`settings_get\`, \`get_agent\`, \`health\`, or an \`exec\`-driven \`openclaw mcp list\` /
  \`models status\`) and confirm the state before reporting success.
- **Mission sessions are shared, not yours.** Read \`mission_sessions\` before typing into
  a session you did not start: you are writing into the human's live conversation. A
  session with \`locked: true\` is their deliberate "driving alone" switch — \`mission_send\`
  refuses it with \`mission_session_locked\` and types nothing. Do not retry that; use
  another session, or ask. A \`live: false\` session is one \`mission_session_restart\` away — same row,
  same tmux id, same conversation — so read its \`lastScreen\` first (\`screenFrom:
  "last-captured"\`) and restart it rather than asking the human. Typing into it fails
  until you do.
- **A session row tells you whether the human is mid-turn, and the answer has three
  states.** \`busy: true\` means a turn is streaming right now: let it finish, then read
  the screen. \`busy: false\` WITH \`busyKnown: true\` means genuinely idle. \`busyKnown:
  false\` means the probe could not answer — **that is unknown, not idle**, and it is not
  permission to type. \`open\` is the union (live OR busy) and \`openCount\` is its per-
  project total. So "is anyone driving right now?" is a read, not a guess: check \`busy\`
  first and only treat a session as quiet when \`busyKnown\` is true. One honest limit:
  the probe asks about the *project folder*, and a session's human can be working in a
  different directory (detail mode's \`state.cwd\` is the ground truth). If that is the
  case, treat \`busy: false\` as "idle in the project folder", not as "idle".
- **Mission error codes are yours to branch on:** \`mission_session_locked\` (human is
  driving alone), \`mission_session_dead\` (the tmux session is gone), \`mission_agent_stopped\`
  (start the PAD first), \`mission_folder_missing\` (the folder vanished inside the PAD —
  fix the project), \`mission_unsupported_agent\` (that type has no Mission projects),
  \`mission_project_forbidden\` (not your PAD).

## Plans — the durable record of a piece of work

A conversation is not a record. It scrolls, it is scoped to one agent, and it ends.
A **plan** is one markdown file per piece of work, living in that PAD's workspace
under \`plans/\`, and it outlives every session that touched it. Three tools:

- \`plan_list {agent, path?, archive?, folder?}\` — the plans in one PAD, newest activity first.
  Each row carries \`status\` (its \`## Status:\` line), \`title\`, the \`session\` it is bound
  to, and the derived \`ageMs\` / \`idleMs\` / \`elapsedMs\`. Pass \`path\` to get ONE plan's
  body; \`archive: true\` lists \`plans/archive/\` (finished work) instead. A plan whose
  \`session\` is also a Mission session carries \`sessionTracked\` / \`sessionLive\` /
  \`sessionOpen\` / \`sessionBusy\` — \`sessionTracked: false\` means the conversation was
  started outside the page, which is NOT the same as dead, plus \`sessionProject\` when it is.
- \`plan_write {agent, path, content, session?}\` — write the file. \`agent\` is REQUIRED on
  every plan tool: the plans folder is per-PAD, three pads can share one workspace,
  and a tool that guessed the root would write into somebody else's project. The body
  is yours; the frontmatter (\`created\`, \`last_activity\`, \`started\`, \`session\`) is
  machine-managed and is what makes the listing answer "what is being worked on RIGHT
  NOW". The folder is created on the first plan, and only then.
- \`plan_activity {agent, session_id}\` — what one conversation is doing, from that
  agent's OWN store (opencode sqlite, codex/claude rollout jsonl): the last user and
  assistant text with timestamps, the last tool call with \`running\` / \`completed\` /
  \`error\`, and \`lastActivityAt\`. A **stopped** pad still answers — the store is on the
  host, so the read never needs the container. Cost differs by driver: on opencode it is
  one indexed sqlite query (~2 ms), on codex/claude it parses that one conversation's
  jsonl file — fine to poll a live session, not a loop over every id. Never
  \`docker exec\`. \`store.reason\` distinguishes a pad that keeps
  no such store, a store with no schema yet, an unopenable file, and "this store has
  transcripts but not that one" (which names its candidates). Secret-shaped config is
  scrubbed; free prose is not pattern-matched, so do not paste secrets into a
  conversation you intend to read this way.

**How this fits the Mission tools.** \`mission_projects\` / \`mission_sessions\` answer
"who is driving right now" — liveness, not progress: a session that did 400 tool calls
and one that opened and died look identical there. The plans answer the other half,
"what has this project been worked on": plan files live in the PAD's workspace, not in a
project's folder, so a plan belongs to a project through the \`sessionProject\` of its
bound session — and \`plan_list {agent, folder}\` does that narrowing for you (plans whose
session the page does not know come back as \`sessionUnattributed\`, never quietly
dropped). Take the \`folder\` from \`mission_projects\`.
## Workflow recipes

1. **Survey the fleet:** \`list_agents\` → \`get_agent\` (or \`agent_logs\`) for detail/logs.
2. **Inspect before changing anything:** \`settings_get\` → (optional) \`config_get\`, \`health\`.
3. **Create a PAD:** \`create_agent\` (bare name, agent type, \`confirm: true\`, optional
   allowDocker/network/workspace/ssh/ports/hooks/web). Verify with \`get_agent\` +
   \`settings_get\`. If the call times out, poll \`job_status\` — do NOT re-create.
4. **Update to latest:** \`update\` (or \`recreate {pull:true}\`). Config/data survive.
5. **Change a setting / web / ssh / ports:** one \`recreate\` with only the options that change.
6. **Health check / explain why down:** \`health\` (works on stopped containers).
7. **Write a workspace file:** \`workspace_write\`. There is deliberately NO browse
   tool: listing a whole tree into your context is a large, usually unwanted read, and
   the plans facility is the browsable surface. A refusal here is a POLICY decision
   about *this* PAD, not a missing capability — \`settings_get\` returns
   \`workspaceMount.hostBrowseReason\` saying which, and \`exec\` on a running agent is
   the fallback.
8. **Add a model to an agent:** call \`agent_commands\` for the agent type, read the Models
   catalog, run the non-interactive add via \`exec\` (secrets via \`stdin\`), then verify with
   \`openclaw models status\`.
9. **Add an MCP server to an agent:** \`agent_commands\` → MCP catalog → \`exec\` the add
   command (default \`--no-probe\`), then verify with \`openclaw mcp list\` / \`mcp probe\`.
10. **Run one-off commands / config changes:** \`exec\`.
11. **Delete a PAD:** \`delete_agent\` (\`confirm: true\`, no undo).
12. **See what the human is working on:** \`mission_projects\` → \`mission_sessions\` (filter
     by \`project_id\` / \`agent\`) → \`mission_sessions {session_id}\` for the screen tail of
     that TUI. This is how you know where to help without being told. Check \`busy\` on the
     way past: a session mid-turn is not one to interrupt.
13. **Work in a Mission session (the only way to do work here):** \`mission_session_start
     {project_id, idempotency_key}\` → the TUI comes up in the project folder and the page
     shows it → \`mission_sessions {session_id}\` to read the answer → \`mission_send
     {session_id, text}\` to type your next line. \`mission_project_create\` first if the PAD
     has no project for the folder you need. \`idempotency_key\` is not optional in
     spirit: start with one, and if this call times out send the SAME key again — a timed-out
     call returns nothing, so a blind retry is what opens a second session.
13b. **A session that died:** \`mission_session_restart {session_id}\` puts the pane and the
     same conversation back (\`mission_session_relaunch\` when the pane is alive but the TUI
     exited). Before restarting, read the last thing it said: \`mission_sessions {session_id}\`
     returns it as \`screenFrom: "last-captured"\` with \`lastScreenAt\`. End one you are done
     with using \`mission_session_close {session_id}\` — the row and the conversation survive.


14. **See what a project is WORKING ON:** \`mission_projects {folder}\` for the project's
    folder → \`plan_list {agent}\` and read the plans filed for it (a plan names its own
    folder in the path) → \`plan_activity {agent, session}\` for the last exchange of the
    conversation a plan is bound to. Skip this when the question is only "is anyone
    driving right now" — that is \`mission_sessions\`, and it is cheaper.

## The command catalog

Call \`agent_commands\` with the PAD's \`agent_type\` to get the non-interactive command
catalog for that driver (\`{type, groups: [{title, commands: [{label, cmd, desc, caveats}]}],
notUsable}\`). Commands with \`credentialInput: "stdin"\` need the secret via \`exec.stdin\` —
ask the user for it only at the final write step. Commands listed under \`notUsable\` are
interactive-only: ask the user to run them in the terminal, or use the suggested alternative.`;

/** Read-only guidance — the full guide text (§§1–4). Type is optional; the
 *  guide is driver-agnostic and the catalog is fetched separately. */
function getGuide() {
  return GENERAL_GUIDE;
}

/** The Set B catalog for a type (§5) — the serialized non-interactive commands. */
function getCommandCatalog(type) {
  return getLlmCatalog(type);
}

/** All known types the catalog supports (for the tool schema enum). */
function listCatalogTypes() {
  const { listDrivers } = require('./drivers');
  return listDrivers().map((d) => d.type);
}

module.exports = { GENERAL_GUIDE, getGuide, getCommandCatalog, listCatalogTypes };
