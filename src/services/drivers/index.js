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

/** Driver for a type — falls back to the openclaw driver when a type has none,
 *  so unknown types never crash the caller. */
function getDriver(type) {
  return drivers[type] || openclaw;
}

/** All known drivers as [{ type, label, setupSteps, workspaceCapability,
 *  workspaceDir }] — feeds the CreateAgent select, the commands endpoint, and
 *  the create-form Workspace card (plan 24). */
function listDrivers() {
  return Object.values(drivers).map((d) => ({
    type: d.type,
    label: d.label,
    setupSteps: d.setupSteps || [],
    workspaceCapability: d.workspaceCapability || 'fixed',
    workspaceDir: d.workspaceDir || '',
    dataDir: d.dataDir || '',
  }));
}

/** Set B — the non-interactive LLM command catalog for a type (plan 35a).
 *  Built from the driver's own `llmCommands` (safe non-interactive commands,
 *  with `{key}` placeholders the LLM fills in) and `notUsable` (interactive-only
 *  commands the LLM must hand to the human). Falls back to openclaw. */
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
 *  `read-rsp` bootstraps, the terminal prompt). Falls back to openclaw. */
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

module.exports = { getDriver, listDrivers, getLlmCatalog, getMcp, drivers };
