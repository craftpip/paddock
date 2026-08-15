const fs = require('fs');
const path = require('path');

const USER_UID = parseInt(process.env.PUID || '1000', 10);
const USER_GID = parseInt(process.env.PGID || '1000', 10);

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
const DATA_DIR = path.join(WORKSPACE, 'src', 'data');
const DB_FILES = ['app.db', 'app.db-wal', 'app.db-shm'];

// Agent types whose data dirs own their ownership: their daemons drop to a
// non-PUID user and chown the bind mount on every boot, so normalizing those
// dirs to USER_UID is undone on the next boot anyway (and would fight the
// agent's own chown). The boot sweep and reset paths skip them.
const SELF_MANAGED_AGENTS = new Set(['hermes']);

/** True for an agent data dir (`<instancesRoot>/<pad>/<agent>`) whose driver is
 *  self-managing (see SELF_MANAGED_AGENTS). Depth-exact: a pad *named* hermes
 *  (`<root>/hermes`) or a user folder named hermes deeper inside a workspace is
 *  NOT excluded. */
function isSelfManagedAgentData(dir, instancesRoot) {
  const name = path.basename(dir);
  if (!SELF_MANAGED_AGENTS.has(name)) return false;
  const grandparent = path.dirname(path.dirname(dir));
  return grandparent === instancesRoot;
}

/** True when this process is running as root (only root can chown to another user). */
function canChown() {
  try { return process.getuid() === 0; } catch { return false; }
}

/** chown a single path to USER_UID:USER_GID when it is not already owned.
 *  No-op on missing paths; never throws. Returns true when a chown happened. */
function ensureOwned(p) {
  if (!canChown()) return false;
  try {
    const st = fs.statSync(p);
    if (st.uid === USER_UID && st.gid === USER_GID) return false;
    fs.chownSync(p, USER_UID, USER_GID);
    return true;
  } catch { return false; }
}

/** Recursively chown a tree to USER_UID:USER_GID. Symlinks are skipped (never
 *  followed, never rewritten). `skipDir` (optional predicate, called on each
 *  dir) prunes a whole subtree — used to skip self-managing agent data dirs.
 *  Best-effort: a race (file vanished) is ignored. */
function normalizeTree(root, skipDir = null) {
  if (!canChown()) return;
  try { if (!fs.existsSync(root)) return; } catch { return; }
  const walk = (dir) => {
    if (skipDir && skipDir(dir)) return;
    ensureOwned(dir);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const p = path.join(dir, entry);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else ensureOwned(p);
    }
  };
  walk(root);
}

/** Normalize the whole src/data dir (sqlite db + usage csvs). */
function ensureDataOwned() {
  normalizeTree(DATA_DIR);
}

/** chown the sqlite db files — call again AFTER the db is opened, because a
 *  fresh db (or new -wal/-shm) created by a root process is root-owned. */
function ensureDbOwned() {
  for (const f of DB_FILES) ensureOwned(path.join(DATA_DIR, f));
}

module.exports = { USER_UID, USER_GID, ensureOwned, normalizeTree, ensureDataOwned, ensureDbOwned, isSelfManagedAgentData };
