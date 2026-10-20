const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
    // lstat, never stat: a symlink must not grant a chown over its target.
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return false;
    if (st.uid === USER_UID && st.gid === USER_GID) return false;
    fs.chownSync(p, USER_UID, USER_GID);
    return true;
  } catch { return false; }
}

/* ---------------------------------------------------------------- */
/*  Write-time ownership (plan 95)                                  */
/* ---------------------------------------------------------------- */

/** Actionable ownership failure. Carries path/uid/gid only — never content. */
class OwnershipError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'OwnershipError';
    this.code = code;
    Object.assign(this, meta);
  }
}

/** Resolve `p` to a canonical path even when part of it does not exist yet:
 *  realpath the deepest EXISTING ancestor, then re-attach the missing tail. */
function realpathDeep(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) throw e;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Prove `target` (including its missing tail, once resolved) stays inside
 *  `boundary` through every symlink the filesystem would follow. */
function assertWithinBoundary(target, boundary) {
  if (!boundary) {
    throw new OwnershipError('ownership_boundary_missing', `Refusing an unowned write to ${target}: no authorized boundary was given.`, { path: target });
  }
  const base = realpathDeep(boundary);
  const real = realpathDeep(target);
  if (real !== base && !real.startsWith(base + path.sep)) {
    throw new OwnershipError('ownership_path_escape', `Refusing to write ${target}: it resolves outside the authorized root ${boundary}.`, { path: target });
  }
  return real;
}

/** Verify the target's uid/gid and correct it when this process may chown.
 *  Unlike `ensureOwned`, failures are THROWN with an actionable code: a write
 *  that succeeded but whose ownership could not be corrected is not `ok`. */
function ensureOwnedStrict(p, { contentWritten = false } = {}) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    throw new OwnershipError('ownership_target_missing', `Ownership check failed for ${p}: ${e.code || e.message}`, { path: p, contentWritten });
  }
  if (st.isSymbolicLink()) {
    throw new OwnershipError(
      'ownership_symlink_refused',
      `Ownership check refused for ${p}: it is a symlink and its target was not changed${contentWritten ? ' (content was already written)' : ''}.`,
      { path: p, contentWritten }
    );
  }
  if (st.uid === USER_UID && st.gid === USER_GID) {
    return { path: p, uid: st.uid, gid: st.gid, changed: false };
  }
  if (!canChown()) {
    throw new OwnershipError(
      'ownership_chown_denied',
      `Ownership check failed for ${p}: expected ${USER_UID}:${USER_GID}, found ${st.uid}:${st.gid}, and this process cannot chown${contentWritten ? ' (content was already written)' : ''}.`,
      { path: p, uid: st.uid, gid: st.gid, contentWritten }
    );
  }
  try {
    fs.chownSync(p, USER_UID, USER_GID);
  } catch (e) {
    throw new OwnershipError(
      'ownership_chown_failed',
      `Ownership correction failed for ${p}: ${e.code || e.message}${contentWritten ? ' (content was already written)' : ''}.`,
      { path: p, contentWritten, cause: e.code || e.message }
    );
  }
  st = fs.lstatSync(p);
  if (st.uid !== USER_UID || st.gid !== USER_GID) {
    throw new OwnershipError(
      'ownership_verify_failed',
      `Ownership verification failed for ${p}: expected ${USER_UID}:${USER_GID}, found ${st.uid}:${st.gid}${contentWritten ? ' (content was already written)' : ''}.`,
      { path: p, uid: st.uid, gid: st.gid, contentWritten }
    );
  }
  return { path: p, uid: st.uid, gid: st.gid, changed: true };
}

/** Create a directory tree, normalizing ONLY the directories this call created.
 *  Pre-existing ancestors are traversed but never chowned. The boundary check
 *  runs before anything is created, through symlinks. */
function mkdirOwned(p, { boundary, mode } = {}) {
  const target = path.resolve(p);
  assertWithinBoundary(target, boundary);
  const missing = [];
  let cur = target;
  for (;;) {
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      missing.push(cur);
      const parent = path.dirname(cur);
      if (parent === cur) throw e;
      cur = parent;
      continue;
    }
    if (cur === target && st.isSymbolicLink()) {
      throw new OwnershipError('ownership_symlink_refused', `Refusing to use the symlink ${cur} as an owned directory.`, { path: cur });
    }
    if (!st.isDirectory()) {
      throw new OwnershipError('ownership_not_a_directory', `Cannot create ${target}: ${cur} is not a directory.`, { path: cur });
    }
    break;
  }
  const created = [];
  for (const dir of missing.reverse()) {
    try {
      fs.mkdirSync(dir, mode !== undefined ? { mode } : undefined);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      continue; // another writer created it; it is not ours to chown
    }
    ensureOwnedStrict(dir);
    created.push(dir);
  }
  return { path: target, created };
}

/** Write a file after normalizing its parent directories and the file itself.
 *  The final path is checked for symlinks BEFORE writing, so an external
 *  target is never written through. `exclusive` preserves the queue's
 *  create-only contract. */
function writeFileOwned(p, content, { boundary, exclusive = false, mode } = {}) {
  const target = path.resolve(p);
  let existingMode;
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) {
      throw new OwnershipError('ownership_symlink_refused', `Refusing to write ${target}: it is a symlink to another file.`, { path: target });
    }
    if (st.isDirectory()) throw new OwnershipError('ownership_not_a_file', `Cannot write ${target}: it is a directory.`, { path: target });
    existingMode = st.mode & 0o7777;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  assertWithinBoundary(target, boundary);
  mkdirOwned(path.dirname(target), { boundary });
  const opts = { encoding: typeof content === 'string' ? 'utf8' : undefined };
  if (exclusive) opts.flag = 'wx';
  if (mode !== undefined) opts.mode = mode;
  else if (existingMode !== undefined) opts.mode = existingMode;
  fs.writeFileSync(target, content, opts);
  return ensureOwnedStrict(target, { contentWritten: true });
}

/** Atomic replacement that normalizes the temporary inode BEFORE it is exposed
 *  at the final path, preserves an existing file's mode, and verifies the final
 *  path. Used by the queue's CAS writer. */
function atomicWriteOwned(p, content, { boundary, mode } = {}) {
  const target = path.resolve(p);
  let existingMode;
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) {
      throw new OwnershipError('ownership_symlink_refused', `Refusing to replace ${target}: it is a symlink to another file.`, { path: target });
    }
    if (st.isDirectory()) throw new OwnershipError('ownership_not_a_file', `Cannot replace ${target}: it is a directory.`, { path: target });
    existingMode = st.mode & 0o7777;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  assertWithinBoundary(target, boundary);
  mkdirOwned(path.dirname(target), { boundary });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const finalMode = mode !== undefined ? mode : (existingMode !== undefined ? existingMode : 0o666);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', finalMode);
    fs.writeFileSync(fd, content);
    fs.closeSync(fd);
    fd = undefined;
    ensureOwnedStrict(tmp, { contentWritten: true });
    fs.renameSync(tmp, target);
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  return ensureOwnedStrict(target, { contentWritten: true });
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

module.exports = {
  USER_UID, USER_GID, ensureOwned, normalizeTree, ensureDataOwned, ensureDbOwned, isSelfManagedAgentData,
  OwnershipError, ensureOwnedStrict, mkdirOwned, writeFileOwned, atomicWriteOwned,
};
