export function callbackOutput(result) {
  const succeeded = result.status === 'ok' && result.exit_code === 0;
  const failed = ['error', 'timeout'].includes(result.status);
  // Older wrappers used console.log(stream, text), baking the transport name
  // into otherwise successful Compose progress. Keep persisted history intact.
  const readable = (text) => succeeded
    ? (text || '').replace(/^(?:stderr|stdout|system)[ \t]+(?=Container\s|Reclaimed\s)/gm, '').replace(/\n{3,}/g, '\n\n').trim()
    : (text || '').trim();
  const labels = { ok: 'Completed', error: 'Failed', timeout: 'Timed out', unknown: 'Outcome unknown', pending: 'Pending', running: 'Running' };
  return {
    label: labels[result.status] || result.status,
    failed,
    output: readable(result.stdout),
    diagnostics: readable(result.stderr),
  };
}
