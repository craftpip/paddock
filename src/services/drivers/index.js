const openclaw = require('./openclaw');

// Registry of agent drivers. One module per agent type; every type is an equal
// citizen. getDriver(type) is the single source of truth for how the dashboard,
// terminal, and routes treat an agent of that type.
const drivers = { openclaw };

/** Driver for a type — falls back to the openclaw driver when a type has none,
 *  so unknown types never crash the caller. */
function getDriver(type) {
  return drivers[type] || openclaw;
}

/** All known drivers as [{ type, label, setupSteps }] — feeds the CreateAgent
 *  select and the commands endpoint. */
function listDrivers() {
  return Object.values(drivers).map((d) => ({
    type: d.type,
    label: d.label,
    setupSteps: d.setupSteps || [],
  }));
}

module.exports = { getDriver, listDrivers, drivers };
