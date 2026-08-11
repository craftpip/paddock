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

module.exports = { getDriver, listDrivers, getLlmCatalog, drivers };
