// Minimal line diff for the Dev Container card preview (plan 41 item 20) —
// no diff library in the bundle. LCS-based, capped at 500 lines per side.
export function lineDiff(a, b) {
  const cap = (s) => (s || '').replace(/\n$/, '').split('\n')
  let aLines = cap(a)
  let bLines = cap(b)
  const truncated = aLines.length > 500 || bLines.length > 500
  aLines = aLines.slice(0, 500)
  bLines = bLines.slice(0, 500)
  const m = aLines.length
  const n = bLines.length
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  let sameRun = 0
  const flush = () => {
    if (sameRun > 0) {
      out.push({ t: 'same', s: '', n: sameRun })
      sameRun = 0
    }
  }
  while (i < m && j < n) {
    if (aLines[i] === bLines[j]) { sameRun++; i++; j++ }
    else {
      flush()
      if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', s: aLines[i] }); i++ }
      else { out.push({ t: 'add', s: bLines[j] }); j++ }
    }
  }
  flush()
  while (i < m) { out.push({ t: 'del', s: aLines[i] }); i++ }
  while (j < n) { out.push({ t: 'add', s: bLines[j] }); j++ }
  if (truncated) out.push({ t: 'more', s: '' })
  return out
}

export default function DiffPreview({ from, to }) {
  const rows = lineDiff(from, to)
  const changes = rows.filter((r) => r.t === 'add' || r.t === 'del').length
  if (changes === 0) {
    return <p className="text-xs text-success mt-1">In sync — the file already matches the pad's settings.</p>
  }
  return (
    <div className="rounded-card border border-line-faint bg-sunken overflow-hidden">
      <div className="max-h-64 overflow-y-auto">
        <pre className="text-[11px] leading-5 font-mono py-1.5 px-2">
          {rows.map((r, idx) =>
            r.t === 'same' ? (
              <span key={idx} className="block text-ink-dim/50">
                {r.n > 1 ? `⋯ ${r.n} identical lines` : r.n === 1 ? '…' : ''}
              </span>
            ) : r.t === 'more' ? (
              <span key={idx} className="block text-ink-dim italic">… truncated at 500 lines</span>
            ) : (
              <span key={idx} className={`block ${r.t === 'add' ? 'text-success' : 'text-danger'}`}>
                {r.t === 'add' ? '+' : '-'}{r.s}
              </span>
            ),
          )}
        </pre>
      </div>
    </div>
  )
}
