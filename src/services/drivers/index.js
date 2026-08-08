const openclaw = require('./openclaw');
const opencode = require('./opencode');
const picoclaw = require('./picoclaw');
const hermes = require('./hermes');
const codex = require('./codex');

// Registry of agent drivers. One module per agent type; every type is an equal
// citizen. getDriver(type) is the single source of truth for how the dashboard,
// terminal, and routes treat an agent of that type.
const drivers = { openclaw, opencode, picoclaw, hermes, codex };

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

module.exports = { getDriver, listDrivers, drivers };
