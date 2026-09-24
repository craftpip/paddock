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
secrets redacted for JSON), \`settings_get\` (the ONE read tool — full picture before any
change), \`health\` (declared-vs-live checkup, works on stopped containers),
\`workspace_list\` / \`workspace_read\` / \`workspace_write\` (browse/read/write workspace files).

**Control:** \`create_agent\`, \`start_agent\` / \`stop_agent\` / \`restart_agent\`, \`recreate\`
(the single mutation gun), \`update\` (alias for \`recreate {pull:true}\`), \`delete_agent\`.

**Exec:** \`exec\` runs any shell command inside a PAD (\`docker exec -i sh -lc\`) — the vehicle
for agent-config commands (models, MCP servers, skills, ...). Optional \`stdin\` is written
verbatim to the process stdin; use it for secrets, never put secrets in the command text.

**Task queue:** \`task_submit\` (push: run \`opencode run\` in a PAD now; pull: file to the
shared pool, optionally addressed with \`enqueue:true\`), \`task_status\` / \`task_result\` /
\`task_list\` (read), \`task_get_next\` / \`task_complete\` / \`task_priority\` / \`task_cancel\`
(exec bucket). Push runs the task for you; pull lets a worker PAD claim work itself with
\`task_get_next\`, do it, and report with \`task_complete\` until the queue is empty.

## Caller rules — read this before mutating anything

- **Read-tool discipline:** run \`settings_get\` first. It returns everything (settings, ssh,
  workspace mount, volumes/ports, image/version, networkHealth, web publish state,
  availableNetworks). Reconstruct the picture before changing anything.
- **Change only what you specify:** \`recreate\` leaves every unspecified option untouched.
  \`undefined\` = keep; \`[]\` / \`''\` / \`false\` = explicit clear. Never default an option.
- **confirm-gated tools:** \`create_agent\` and \`delete_agent\` require \`confirm: true\`, and
  \`recreate\` requires it when \`reset: true\`. Only pass it after checking with the user.
- **No TTY in \`exec\`:** commands that demand a TTY (\`openclaw onboard\`,
  \`openclaw configure --section model\`, \`openclaw models auth login\`) hang or fail. Use the
  non-interactive alternatives from \`agent_commands\`, or ask the user to run them.
- **Write-only secrets:** \`sshPassword\` / web \`password\` are never returned by any read
  tool; an empty string means "keep current". Never echo them back.
- **Never expose secrets:** \`config_get\` redacts JSON secrets; don't ask for or report raw
  keys/tokens beyond what a command needs. Secrets always go through \`exec.stdin\`.
- **No \`paddock_\` prefix** on tool names — the client namespaces them itself.
- **Verification habit:** after any mutation, re-run the matching read tool
  (\`settings_get\`, \`get_agent\`, \`health\`, or an \`exec\`-driven \`openclaw mcp list\` /
  \`models status\`) and confirm the state before reporting success.

## Workflow recipes

1. **Survey the fleet:** \`list_agents\` → \`get_agent\` (or \`agent_logs\`) for detail/logs.
2. **Inspect before changing anything:** \`settings_get\` → (optional) \`config_get\`, \`health\`.
3. **Create a PAD:** \`create_agent\` (bare name, agent type, \`confirm: true\`, optional
   allowDocker/network/workspace/ssh/ports). Verify with \`get_agent\` + \`settings_get\`.
4. **Update to latest:** \`update\` (or \`recreate {pull:true}\`). Config/data survive.
5. **Change a setting / web / ssh / ports:** one \`recreate\` with only the options that change.
6. **Health check / explain why down:** \`health\` (works on stopped containers).
7. **Work in the workspace:** \`workspace_list\` / \`workspace_read\` / \`workspace_write\`.
8. **Add a model to an agent:** call \`agent_commands\` for the agent type, read the Models
   catalog, run the non-interactive add via \`exec\` (secrets via \`stdin\`), then verify with
   \`openclaw models status\`.
9. **Add an MCP server to an agent:** \`agent_commands\` → MCP catalog → \`exec\` the add
   command (default \`--no-probe\`), then verify with \`openclaw mcp list\` / \`mcp probe\`.
10. **Run one-off commands / config changes:** \`exec\`.
11. **Delete a PAD:** \`delete_agent\` (\`confirm: true\`, no undo).
12. **Dispatch a task (push):** \`task_submit {name, prompt}\` → \`task_status\` to poll,
    \`task_result\` for the answer, \`task_cancel {confirm: true}\` to stop it.
13. **Work a queue (pull):** \`task_get_next {name}\` → do the work yourself → \`task_complete\`
    → repeat until \`queueEmpty\`. Rank the backlog with \`task_priority\`.

## Headless opencode rules — read before submitting any task

- The task runs as \`opencode run --format json --dir <workspace>\` — the PAD's own
  workspace, never the container root.
- Agent selection is \`--agent <name>\` only. **Never \`@mention\` an agent in the
  prompt** — headless runs silently fall through to the primary agent's model.
- Tasks auto-approve permissions not explicitly denied (\`--auto\`). Pass
  \`autoApprove: false\` only if you can answer the approval yourself.

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
