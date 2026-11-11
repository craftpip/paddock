// OpenCode's exhausted free-model TUI shows two things, captured on 1.19.0
// (2026-10-19) and again on 1.19.5 (2026-11-11):
//
//   1. a status line under the input:
//        Free usage exceeded, subscribe to Go [retrying in 8h 58m attempt #1]
//   2. a modal over the conversation, titled "Free limit reached" with an
//      `esc` hint on the same row and a body starting "Subscribe to OpenCode Go".
//
// The status line needs about 75 columns. In a narrow pane (40x12 with the
// queue panel open) only its closing bracket is drawn, so matching it alone
// left a stuck runner reading "Running" for as long as the pane stayed narrow.
// The modal wraps instead of clipping, so it is recognised at any width.
//
// A transient 429, an empty assistant step, an idle worker, or the worker
// merely QUOTING either notice in its own output does not establish quota
// exhaustion: the status line must start its row, and the modal needs its
// title-and-esc row followed closely by its body.
const REASON = 'OpenCode free usage limit reached — subscribe to Go or wait for quota reset';

function statusNotice(lines) {
  return lines.find((line) =>
    /^\s*[^\w\n]*Free usage exceeded, subscribe to Go\s*\[retrying in .+ attempt #\d+\]/.test(line)) || null;
}

function modalNotice(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    // Title and close hint share one row, separated by the modal's padding.
    if (!/Free limit reached\s{2,}esc\b/.test(lines[i])) continue;
    // The body follows within the modal; at a narrow width it wraps over
    // several rows, so join them before looking.
    const body = lines.slice(i + 1, i + 9).join(' ').replace(/\s+/g, ' ');
    if (/Subscribe to OpenCode Go\b/.test(body)) return 'Free limit reached — Subscribe to OpenCode Go';
  }
  return null;
}

function screenUsageEvidence(screen) {
  if (!screen?.live || typeof screen.text !== 'string') return null;
  const lines = screen.text.split('\n');
  const status = statusNotice(lines);
  const modal = status ? null : modalNotice(lines);
  if (!status && !modal) return null;
  return {
    state: 'exhausted',
    definitive: true,
    reason: REASON,
    evidence: { source: 'live-terminal', notice: (status || modal).trim(), via: status ? 'status-line' : 'modal' },
  };
}

module.exports = { screenUsageEvidence };
