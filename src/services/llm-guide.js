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
In a **user-mode** PAD (the agent runs as the pad user) \`exec\` drops to that same user
(uid 1000, \`HOME=/root\`) instead of root — expect no \`apt-get\`/root-only writes there; a
root-mode PAD runs \`exec\` as root.

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
\`mission_session_close\` ends one deliberately. A session parked on a
\`△ Permission required\` dialog is BLOCKED, not idle: detail mode reports
\`blockedOn: "permission"\`, and you answer it with \`mission_permission_answer\` (\`once\`
or \`reject\`) instead of trying to type. All are scoped to the PADs your key
may see. One cost to know before \`recreate\`: it kills every live Mission session on
that PAD (rows survive as dead; \`mission_session_restart\` brings each back on the same
conversation).

**Runners (a queue of plans worked unattended in one session):** a runner types one plan
after another into its worker session and waits for each turn to finish.
\`runner_create {project_id, name, plans}\` makes one (a new worker session unless you pass
\`session_id\`) with its queue set up and the plans queued; \`runner_start\` presses Run.
Poll \`runner_get {runner_id}\`: it returns the whole picture in one shape (state + label,
every item with status \`new\` / \`in_progress\` / \`need_input\` / \`done\`, \`blocked\` with
the worker's question, \`can.*\` = true or why not, and \`next\` = the call to make). When a
plan needs a decision the worker marks it \`need_input\` with its question and the runner
stops; answer with \`agent_queue_resolve_need_input {runner_id, item_id, answer}\` and the
worker continues by itself. \`runner_pause\`, \`runner_reconcile\` (an instruction sent but
not acknowledged — never re-sends), \`runner_remove\`, \`queue_write\` (add plans) and
\`agent_queue_remove_item\` complete the set. A provider usage limit stops the runner with
label "Usage limit" — nothing to answer; it resumes by itself once the provider answers
again, or call \`runner_start\` after the reset.

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
- **Spend nothing invisible: reuse a session before you open one.** Before
  \`mission_session_start\`, read \`mission_sessions {project_id}\` and ask whether one
  already fits. A live session with the work in progress, or one that is a
  \`shell\` kind (pane alive, TUI exited) that \`mission_session_relaunch\` can bring
  back, is a conversation that already has your context in it — starting fresh
  means paying to re-establish what the other session already knows. Prefer, in
  order: the live session that already fits → relaunch the shell one → only then
  start a new one. Do NOT re-send a prompt into a session that already has the
  answer: check \`plan_activity\` (or the screen tail) for whether the last turn
  finished first. Opening a session also **burns tokens whether or not anyone is
  watching**, so a session you open and abandon is money spent for nothing.
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
  project total. The word that matters before typing is \`canSend\` (detail mode), which
  is the SAME check the write path applies — a solo-locked row and a permission-parked
  row are both still \`open\`, but neither may be typed into. So "is anyone driving right
  now?" is a read, not a guess: check \`busy\` first and only treat a session as quiet
  when \`busyKnown\` is true. One honest limit:
  the probe asks about the *project folder*, and a session's human can be working in a
  different directory (detail mode's \`state.cwd\` is the ground truth). If that is the
  case, treat \`busy: false\` as "idle in the project folder", not as "idle".
- **Mission error codes are yours to branch on:** \`mission_session_locked\` (human is
  driving alone), \`mission_session_dead\` (the tmux session is gone), \`mission_agent_stopped\`
  (start the PAD first), \`mission_folder_missing\` (the folder vanished inside the PAD —
  fix the project), \`mission_unsupported_agent\` (that type has no Mission projects),
  \`mission_project_forbidden\` (not your PAD), \`mission_permission_pending\` (a tool
  call is parked on a \`△\` dialog — answer it with \`mission_permission_answer\`, do not
  retype), \`mission_not_an_agent\` (a \`mission_send\` there would run as shell — relaunch
  the TUI first), \`mission_tui_already_running\` (the TUI is up — retyping the launch
  would start a second conversation in the pane).

## Plans — the durable record of a piece of work

A conversation is not a record. It scrolls, it is scoped to one agent, and it ends.
A **plan** is one markdown file per piece of work, and it outlives every session that
touched it. Three tools:

- \`plan_list {agent?, project_id?, folder?, path?, archive?}\` — the plans in one SCOPE,
  newest activity first. **Scope is what you pass:** \`project_id\` (or \`folder\`) reads a
  Mission project's OWN plans folder — \`<project.folder>/<plans_folder>\`, default
  \`plans/\`, so two projects on one PAD never share plans; \`agent\` alone reads that
  PAD's PAD-wide \`plans/\` (legacy). An explicit project that matches nothing or several
  is REFUSED with the candidates — never a silent fallback to the PAD folder. Each row
  carries \`status\` (the canonical lifecycle value, see below), \`statusRaw\` (the header
  verbatim), \`title\`, the \`session\` it is bound to, and the derived \`ageMs\` / \`idleMs\`
  / \`elapsedMs\`. Pass \`path\` to get ONE plan's body; \`archive: true\` lists \`archive/\`
  (finished work) instead. A row whose \`session\` is also a Mission session carries
  \`sessionTracked\` / \`sessionLive\` / \`sessionOpen\` / \`sessionBusy\` — \`sessionTracked:
  false\` means the conversation was started outside the page, which is NOT the same as
  dead, plus \`sessionProject\` when it is.
- \`plan_write {agent?, project_id?, folder?, path, content, session?}\` — write the file.
  The body is yours; the frontmatter (\`created\`, \`last_activity\`, \`started\`, \`session\`)
  is machine-managed and is what makes the listing answer "what is being worked on RIGHT
  NOW". The folder is created on the first plan, and an \`INDEX.md\` entry file (whose
  plans these are, the status vocabulary, the queue pointer) is written alongside it —
  once, and never overwritten. \`INDEX.md\`, \`README.md\` and \`QUEUE.md\` are RESERVED and
  refused as \`path\`.
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

**The five statuses are the whole vocabulary.** \`status\` is one of \`new\` / \`in
progress\` / \`blocked\` / \`need clarification\` / \`done\`, matched case-insensitively from
the body's \`## Status:\` line; a header that matches none of them is surfaced verbatim
in \`status\` (\`statusRaw\` always keeps the raw text), NEVER silently turned into an
actionable state. **\`blocked\` and \`need clarification\` are STOP states** — record the
reason and stop; do not proceed to the next queue item. Update the status when the work
moves, not at the end.

**How this fits the Mission tools.** \`mission_projects\` / \`mission_sessions\` answer
"who is driving right now" — liveness, not progress: a session that did 400 tool calls
and one that opened and died look identical there. The plans answer the other half,
"what has this project been worked on": with a project scope the plans folder IS the
project's folder, so \`plan_list {agent, project_id}\` is the project's progress, and the
project row carries its \`plans_folder\`. Take the \`project_id\` (or \`folder\`) from
\`mission_projects\`.

**A plan is also the checklist that survives a closed chat.** There is no separate
notes/journal store — the plan IS the memory, so a multi-step job is one plan whose body
carries the ordered checklist (a plan's body is yours; only the frontmatter is managed).
Work it in order, **one item at a time, in a visible session** — exactly the session rule
above; nothing here runs where the human cannot watch. Tick each item off by rewriting
the checklist in the plan body with \`plan_write {project_id, path, content}\` when it is
done (that bump is what makes \`plan_list\` answer "what is being worked on RIGHT NOW").
Read the plan on arrival (\`plan_list {project_id, path}\`) before starting work, and write
decisions back into it as you make them.
## Workflow recipes

0. **Run a queue of plans and answer its questions (MCP only):** \`mission_projects\` (or
   \`mission_project_create\`) → \`plan_write\` each plan (say in the plan when the worker must
   stop and ask: "mark this item need_input with your question and stop") →
   \`runner_create {project_id, name, plans: [...]}\` → \`runner_start\` → poll \`runner_get\`
   every minute or so. When \`blocked\` is non-empty, decide and call
   \`agent_queue_resolve_need_input {runner_id, item_id, answer}\`; when every item is
   \`done\` the runner says so in \`next\`. Read a worker's screen any time with
   \`mission_sessions {session_id}\`.

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
13. **Work in a Mission session (the only way to do work here):** first
      \`mission_sessions {project_id}\` — if a session already fits, or one is a
      \`shell\` you can \`mission_session_relaunch\`, use that one and skip the next step.
      Otherwise \`mission_session_start {project_id, idempotency_key}\` → the TUI comes up
      in the project folder and the page shows it → \`mission_sessions {session_id}\` to read
      the answer → \`mission_send {session_id, text}\` to type your next line. \`mission_project_create\` first
      if the PAD has no project for the folder you need. \`idempotency_key\` is not optional in
      spirit: start with one, and if this call times out send the SAME key again — a timed-out
      call returns nothing, so a blind retry is what opens a second session.

13b. **A session that died:** \`mission_session_restart {session_id}\` puts the pane and the
     same conversation back (\`mission_session_relaunch\` when the pane is alive but the TUI
     exited). Before restarting, read the last thing it said: \`mission_sessions {session_id}\`
     returns it as \`screenFrom: "last-captured"\` with \`lastScreenAt\`. End one you are done
     with using \`mission_session_close {session_id}\` — the row and the conversation survive.


14. **See what a project is WORKING ON:** \`mission_projects {folder}\` for the project's
    \`project_id\` → \`plan_list {project_id}\` reads THAT project's own plans folder
    (\`<project.folder>/<plans_folder>\`, default \`plans/\`) → \`plan_activity {agent,
    session}\` for the last exchange of the conversation a plan is bound to. Skip this
    when the question is only "is anyone driving right now" — that is
    \`mission_sessions\`, and it is cheaper.

15. **Run a task as a loop (the \`task_*\` tools, when they are listed):** the loop is
    \`review → build → test → (a failed test earns a hotfix) → commit\`. Bind the task
    first — \`task_submit { …, session_id }\` — because a task with no binding cannot be
    pipelined (\`task_pipeline_start\` refuses it with \`task_pipeline_no_session\` rather
    than guessing where to drive). Then \`task_pipeline_start { task_id }\` drives it:
    the server types each step into that session and waits for a report, and each step
    is finished by \`task_step_report { task_id, step, state, status }\` — the verdict
    comes from a report, never from a quiet pane. File defects with \`task_step_bug
    { task_id, file, line, summary, repro }\` (the hotfix prompt quotes them back), and
    take the task's own commit with \`task_step_commit\` (the driver runs git itself and
    records the SHA). Watch it with \`task_pipeline_status { task_id }\` —
    \`{active, state, current_step, next_step, reason}\`; a parked run names its reason
    (\`timeout\`, \`mission_session_dead\`, \`commit_nothing\`, \`needs_review\`, …), and a
    webui restart drops the driver, which \`task_pipeline_status\` says in words ("no
    driver" is not "nothing is happening"). \`task_pipeline_stop { task_id }\` ends a run
    at the next boundary. Refusals are reasons, not errors to work around:
    \`task_pipeline_busy\` (one active step per task), \`task_step_claimed\` (another
    identity already holds that attempt), and the session gates (\`task_session_locked\`,
    \`mission_session_dead\`, \`mission_not_an_agent\`, \`mission_permission_pending\`) —
    each one says the session is not usable right now. The task's own status is still
    set by \`task_complete\`; a step report never sets it.

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
