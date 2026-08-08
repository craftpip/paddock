// Generic tar-based backup and restore was removed by the plan 26 pre-plan.
// Paddock no longer archives a driver's dataDir, extracts archives over the
// live data directory, or clones a PAD from an archive. Native driver
// capabilities replace this module in plan 26 Goal 0. Until then every
// operation refuses to run so nothing silently falls back to the old behavior.

const UNAVAILABLE = 'Generic backups were removed. Native backups are not available yet.';

async function backupAgent() {
  throw new Error(UNAVAILABLE);
}

async function restoreAgent() {
  throw new Error(UNAVAILABLE);
}

module.exports = { backupAgent, restoreAgent };
