/** translateHistoryError — plan 68 Idea 6.
 *
 *  Col 2's history probe fails per project, and the raw reasons it reports are
 *  MACHINE strings — `no-store`, `unreadable`, `Command failed: sqlite3 …`.
 *  Shown verbatim in the column, they read as a shrug; shown translated, the
 *  row names the state and (where one exists) the fix. The translation lives
 *  here, a pure function with no JSX and no react imports, so `node --test`
 *  can pin both halves: that a known reason maps to its words, and that an
 *  unknown string is passed through instead of being smoothed into confidence.
 *
 *  The RAW reason is never lost — the caller renders it as the row's `title`
 *  tooltip, one hover away from the translation, because the machine phrase is
 *  the one a caller (human or agent) can act on.
 *
 *  Order matters: match the most specific clause first. A rejection reason can
 *  carry several of these at once (e.g. `Command failed: … no such table`,
 *  or `pad-x is not running — start it before opening a session`), and every
 *  pattern below must fire on the string that ACTUALLY leaves `mission.js`.
 */
export function translateHistoryError(raw) {
  if (!raw) return "This project's agent history could not be read."
  const s = String(raw)
  // A stopped PAD is the most likely case and the most actionable: the folder
  // probe can't even run, so its whole history is unavailable right now.
  if (/is not running/.test(s)) return "This project's agent is stopped — start it to read its history."
  // `exec … sqlite3` failed: the store exists but refused to be read at probe
  // time. Transient more often than not, and retried on the next poll.
  if (/Command failed/.test(s)) return "This project's history could not be read right now."
  // The four store states the reason string names (workspace.js).
  if (s.includes('no-store')) return 'This agent keeps no readable history in this folder.'
  if (s.includes('empty-store')) return "This agent has not run a conversation in this folder yet."
  if (s.includes('unreadable')) return "This agent's history file exists but could not be opened."
  if (s.includes('sqlite-failed')) return "This agent's history database could not be read."
  if (s.includes('session-not-found')) return 'The conversation this project tracks no longer exists.'
  return s
}