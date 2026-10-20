// Captured from OpenCode 1.19.0's exhausted free-model TUI. A transient 429,
// an empty assistant step, or an idle worker does not establish quota exhaustion.
function screenUsageEvidence(screen) {
  if (!screen?.live || typeof screen.text !== 'string') return null;
  const text = screen.text;
  const status = text.split('\n').find((line) =>
    /^\s*[^\w\n]*Free usage exceeded, subscribe to Go\s*\[retrying in .+ attempt #\d+\]/.test(line));
  if (!status) return null;
  return {
    state: 'exhausted',
    definitive: true,
    reason: 'OpenCode free usage limit reached — subscribe to Go or wait for quota reset',
    evidence: { source: 'live-terminal', notice: status.trim() },
  };
}

module.exports = { screenUsageEvidence };
