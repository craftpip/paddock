// Client mirror of the host-path policy in `src/services/workspace-guards.js`
// (plan 72). This is a COPY, deliberately: the server module uses `require`
// and the shared guard switch, neither of which belongs in a browser bundle,
// and the client needs an answer synchronously while the user is still typing —
// before the probe that would be authoritative has come back.
//
// Two things keep the copy honest, and both are load-bearing:
//
//  1. When the probe DOES come back, its `reason` wins over anything computed
//     here (see `hostSourceIssue` callers in CreateAgent.jsx), so a drift is
//     visible rather than permanent.
//  2. `src/test/workspace-guards.test.js` asserts this module and the server
//     module return the SAME verdict for the same paths, and — the half that
//     matters — that it goes red when they disagree.
//
// Keep the two lists and the two branches identical. If you change one, change
// both, and run that test.

export const HOST_HARD_BLOCK = ['/etc', '/proc', '/sys', '/dev', '/boot', '/bin', '/sbin', '/usr', '/lib', '/var/run']
export const HOST_USER_DATA = ['/home', '/root', '/opt', '/tmp', '/mnt', '/srv', '/data']

/** Same rule, same order, same codes as the server's `hostSourceIssue`.
 *  Returns `null` when fine, else `{ code, message }`. */
export function hostSourceIssue(input, opts = {}) {
  const noun = opts.noun || 'workspace source'
  const raw = String(input || '').trim()
  if (!raw.startsWith('/')) return null
  const host = raw.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/'

  if (host === '/') {
    return { code: 'workspace_source_host_root', message: 'The workspace source cannot be the host root' }
  }
  for (const sd of HOST_HARD_BLOCK) {
    if (host === sd || host.startsWith(sd + '/')) {
      return {
        code: 'workspace_source_system_dir',
        systemDir: sd,
        message: `The ${noun} cannot be a system directory (${sd})`,
      }
    }
  }
  for (const ud of HOST_USER_DATA) {
    if (host === ud) {
      return {
        code: 'workspace_source_home_root',
        systemDir: ud,
        message:
          `Cannot use a whole home folder (${ud}) as a ${noun} — ` +
          `pick a project folder inside it, e.g. ${ud}/my-project`,
      }
    }
  }
  return null
}