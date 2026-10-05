const openclaw = require('./openclaw');
const opencode = require('./opencode');
const picoclaw = require('./picoclaw');
const hermes = require('./hermes');
const codex = require('./codex');
const claude = require('./claude');

// Registry of agent drivers. One module per agent type; every type is an equal
// citizen. getDriver(type) is the single source of truth for how the dashboard,
// terminal, and routes treat an agent of that type.
const drivers = { openclaw, opencode, picoclaw, hermes, codex, claude };

/** Is `type` a driver we know? Use this to VALIDATE a value that came from a
 *  URL or a request body, before you resolve it — `hasDriver('kk')` is the
 *  question "is this a type?", which is a different question from
 *  "give me the driver" and is the one a 404 should be asking. */
function hasDriver(type) {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(drivers, type);
}

/** Driver for a type — THROWS when the type is not one of ours.
 *
 *  This used to be `drivers[type] || openclaw`, which answered HTTP 200 with
 *  openclaw's commands, MCP block, `tuiCommand`, `dataDir` and `workspaceDir`
 *  for a typo: measured live, `/api/agent-types/opencodee/commands` returned
 *  `type: "openclaw"` and 4 commands instead of a 404. Nothing threw, nothing
 *  was logged, and every field read as a real answer — so the wrong answer was
 *  indistinguishable from success and surfaced much later as a confidently
 *  incorrect path. A throw carries the whole answer the caller needs: which type
 *  it asked for and which types exist.
 *
 *  A **throw**, not `null`: with this many call sites a `null` becomes a
 *  `TypeError: Cannot read properties of null (reading 'workspaceDir')` one line
 *  later, at the dereference instead of at the lookup.
 *
 *  For a type that is absent (not one we cannot resolve) use `getDriverOr`. */
function getDriver(type) {
  if (hasDriver(type)) return drivers[type];
  throw new Error(`unknown_agent_type: '${type}' — known: ${Object.keys(drivers).join(', ')}`);
}

/** Driver for a type, falling back when there is **no type to look up** — a pad
 *  whose `meta.env` predates its `AGENT` line, or a pre-create path that has not
 *  chosen one yet. 3 live pads have no `AGENT` line, so this leniency is real
 *  and load-bearing, and it is what plan 53 relied on to make `mission.supported`
 *  a safe `?.` read.
 *
 *  It deliberately does **NOT** fall back for a type that is present but
 *  unknown: `'opencodee'` is a fact we read and could not resolve, and
 *  answering with openclaw's driver is the substitution this pair exists to
 *  stop. That one throws, from `getDriver`, naming the type and the valid set —
 *  which is far more useful to an operator than a list of openclaw's paths.
 *  `fallback` is a parameter so the leniency is visible and testable. */
function getDriverOr(type, fallback = 'openclaw') {
  if (type === undefined || type === null || String(type).trim() === '') {
    if (hasDriver(fallback)) return drivers[fallback];
    throw new Error(`unknown_driver_fallback: '${fallback}' — known: ${Object.keys(drivers).join(', ')}`);
  }
  return getDriver(type);
}

/** All known drivers as [{ type, label, setupSteps, workspaceCapability,
 *  workspaceDir, mission }] — feeds the CreateAgent select, the commands
 *  endpoint, and the create-form Workspace card (plan 24). `mission.supported`
 *  is the Mission page's agent filter (plan 53): true only for the coding
 *  models, so the picker never has to hardcode a list. */
function listDrivers() {
  return Object.values(drivers).map((d) => ({
    type: d.type,
    label: d.label,
    setupSteps: d.setupSteps || [],
    workspaceCapability: d.workspaceCapability || 'fixed',
    workspaceDir: d.workspaceDir || '',
    dataDir: d.dataDir || '',
    mission: { supported: !!(d.mission && d.mission.supported) },
  }));
}

/** Set B — the non-interactive LLM command catalog for a type (plan 35a).
 *  Built from the driver's own `llmCommands` (safe non-interactive commands,
 *  with `{key}` placeholders the LLM fills in) and `notUsable` (interactive-only
 *  commands the LLM must hand to the human).
 *  Throws for an unknown type like every other resolution here. */
function getLlmCatalog(type) {
  const d = getDriver(type);
  return {
    type: d.type,
    label: d.label,
    tuiCommand: d.tuiCommand || 'openclaw',
    groups: (d.llmCommands || []).map((g) => ({
      title: g.title,
      commands: (g.commands || []).map((c) => ({
        label: c.label,
        cmd: c.cmd,
        desc: c.desc || '',
        ...(c.caveats ? { caveats: c.caveats } : {}),
        ...(c.credentialInput ? { credentialInput: c.credentialInput } : {}),
      })),
    })),
    notUsable: (d.notUsable || []).map((c) => ({
      label: c.label,
      cmd: c.cmd,
      desc: c.desc || '',
    })),
  };
}

/** Paddock MCP server operations for a type (plan 35b). Serializes the
 *  driver's `mcp` object into capability descriptors + prebuilt shell commands
 *  for the current Paddock MCP URL. `{ key, ... }` in a command is the secret
 *  placeholder the frontend replaces with the pasted API key (or, for
 *  `read-rsp` bootstraps, the terminal prompt). Throws for an unknown type. */
function getMcp(type, url) {
  const d = getDriver(type);
  const mcp = d.mcp || openclaw.mcp;
  const build = (kind) => {
    const fn = mcp[`build${kind}`];
    return typeof fn === 'function' ? fn.call(mcp, { url }) : null;
  };
  return {
    type: d.type,
    label: d.label,
    url,
    serverName: mcp.serverName || 'paddock',
    capabilities: mcp.capabilities || {},
    commands: {
      connect: build('Connect'),
      disconnect: build('Disconnect'),
      inspect: build('Inspect'),
      test: build('Test'),
    },
  };
}

module.exports = { getDriver, getDriverOr, hasDriver, listDrivers, getLlmCatalog, getMcp, drivers };
