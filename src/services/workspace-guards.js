// One source of truth for "may this HOST path be a workspace / volume source?"
// (plan 72)
//
// This list used to be written out five times — twice in vm-manager (the
// create path and the settings-apply path), once in path-probe, and twice more
// in CreateAgent.jsx — which is why the rule was "whatever those five say".
// The split matters as much as the sharing: the two halves are different
// decisions, and collapsing them was the original bug.
//
//   hard-block — never a source, exact OR under. These hold no user projects.
//   user-data  — the BARE root is refused, any subdirectory is fine. These are
//                scratch / application roots, where the sensitive content sits
//                one level down anyway: refusing the subpath protects nothing
//                while refusing the legitimate project, and the only thing the
//                bare-root refusal actually buys is "don't hand an agent a whole
//                root".
//
// `/home`, `/root` and `/mnt` were in the user-data list and were REMOVED
// (plan 77): they are data / home roots the operator mounts whole on this host,
// and refusing them bare broke a recreate of a working pad — `pad-opencode-proj`
// carries a stored `{"host":"/mnt","container":"/mnt"}` extra volume, so a
// network-only settings apply re-validated it and failed on a guard that had
// nothing to do with the change. Exactly the failure plan 72 avoided for /www1.
//
// `/www1` is deliberately NOT in either list. It is a projects root, not a home,
// and it is allowed today including bare — listing it here would silently
// narrow existing working setups (craftpip) to buy a foot-gun nobody asked to
// be protected from.

const HOST_HARD_BLOCK = ['/etc', '/proc', '/sys', '/dev', '/boot', '/bin', '/sbin', '/usr', '/lib', '/var/run'];
const HOST_USER_DATA = ['/opt', '/tmp', '/srv', '/data'];

const OFF_VALUES = ['0', 'false', 'no', 'off', 'disabled', 'disable'];

/** Whether a named workspace-mount guard is active. Every guard is ON by
 *  default; set `GUARD_<NAME>` to `0`/`false`/`no`/`off` to disable that single
 *  check. Kept here (not in vm-manager) so every consumer of the lists above
 *  resolves a guard the same way — a guard that only one module knows about is
 *  a guard the other module silently ignores. */
function guard(name) {
  const v = String(process.env[`GUARD_${name}`] || '').trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/** Normalize a host path the way the mounts do: absolute, collapsed slashes,
 *  no trailing slash. Returns '' for input that is not absolute. */
function normalizeHostPath(input) {
  const raw = String(input || '').trim();
  if (!raw.startsWith('/')) return '';
  const collapsed = raw.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return collapsed || '/';
}

/** Classify one host path against the two lists.
 *
 *  Returns `null` when the path is acceptable, else `{ code, message }`.
 *  `code` is the machine-readable half and is what tests and callers branch on;
 *  `message` is what a human reads, so each half stays in step with the other.
 *  The two guards are independent: turning off SYSTEM_DIRS (the pre-plan-72
 *  all-or-nothing escape hatch, which also re-opens /etc and /proc) does not
 *  re-open the bare home folders, and vice versa.
 *
 *  `noun` is the thing being mounted ("workspace source" by default, "host
 *  source" for an extra volume). It is passed in rather than substituted into
 *  the finished sentence so the two call sites cannot end up disagreeing about
 *  what they are complaining about. */
function hostSourceIssue(input, opts = {}) {
  const hardBlocked = opts.hardBlocked === undefined ? guard('SYSTEM_DIRS') : opts.hardBlocked;
  const userRootsGuarded = opts.userRoots === undefined ? guard('USER_DIRS') : opts.userRoots;
  const noun = opts.noun || 'workspace source';
  const host = normalizeHostPath(input);
  if (!host) return null;

  // The host root is nonsense as a mount source and is refused regardless of
  // either guard: it is the one path where "pick a subdirectory" is not
  // advice the caller can act on. The form already refused it and the server
  // never did — the client/server disagreement this whole plan exists to close.
  if (host === '/') {
    return { code: 'workspace_source_host_root', message: 'The workspace source cannot be the host root' };
  }

  if (hardBlocked) {
    for (const sd of HOST_HARD_BLOCK) {
      if (host === sd || host.startsWith(sd + '/')) {
        return {
          code: 'workspace_source_system_dir',
          systemDir: sd,
          message: `The ${noun} cannot be a system directory (${sd})`,
        };
      }
    }
  }
  if (userRootsGuarded) {
    for (const ud of HOST_USER_DATA) {
      if (host === ud) {
        return {
          code: 'workspace_source_home_root',
          systemDir: ud,
          message:
            `Cannot use a whole home folder (${ud}) as a ${noun} — ` +
            `pick a project folder inside it, e.g. ${ud}/my-project`,
        };
      }
    }
  }
  return null;
}

/** Boolean form, for the probe's `forbidden` flag and its autocomplete filter. */
function isForbiddenHostSource(input) {
  return hostSourceIssue(input) !== null;
}

module.exports = {
  HOST_HARD_BLOCK,
  HOST_USER_DATA,
  guard,
  normalizeHostPath,
  hostSourceIssue,
  isForbiddenHostSource,
};