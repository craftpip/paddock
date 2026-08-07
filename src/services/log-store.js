/**
 * Persistent container logs.
 *
 * `docker logs` output dies the moment a container is recreated or deleted
 * (docker rm removes the container's log file), so a freshly-recreated PAD
 * starts with an empty Logs tab. This service captures each container's logs
 * into a rolling file at `instances/<name>/logs/container.log` on the host
 * bind mount. Captures run:
 *
 *   1. on every logs API fetch — the view is always fresh,
 *   2. on a periodic sweep in app.js — logs persist even if nobody looks,
 *   3. right before a recreate/delete in the backend flows — the final lines
 *      before the container is removed survive the sweep window.
 *
 * Dedup: `docker logs --timestamps` prefixes every line with an RFC3339Nano
 * timestamp. We parse it, keep only lines newer than the last captured
 * timestamp, and record that timestamp in `meta.json`. Because docker log
 * timestamps come from the host clock and are monotonic per container, a
 * freshly-recreated container's logs all sort after the previous container's,
 * so the file becomes one continuous stream — no dupes, no gaps.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
const INSTANCES_DIR = path.join(WORKSPACE, 'instances');

/** Keep the file below this size; trimming only happens when it's exceeded. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LINES = 20000;

function runCmd(cmd, args, options = {}) {
  const { timeout = 30000 } = options;
  return new Promise((resolve) => {
    execFile(cmd, args || [], { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? err.code : 0 });
    });
  });
}

function logDir(name) {
  return path.join(INSTANCES_DIR, name, 'logs');
}

function logFile(name) {
  return path.join(logDir(name), 'container.log');
}

function metaFile(name) {
  return path.join(logDir(name), 'meta.json');
}

function readMeta(name) {
  try {
    return JSON.parse(fs.readFileSync(metaFile(name), 'utf8'));
  } catch {
    return { lastTs: 0 };
  }
}

function writeMeta(name, meta) {
  try {
    fs.mkdirSync(logDir(name), { recursive: true });
    fs.writeFileSync(metaFile(name), JSON.stringify(meta));
  } catch {}
}

/** Trim the rolling file when it grows past the cap. */
function trim(name) {
  try {
    const f = logFile(name);
    if (fs.statSync(f).size < MAX_FILE_BYTES) return;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    if (lines.length > MAX_LINES) {
      fs.writeFileSync(f, lines.slice(-MAX_LINES).join('\n'));
    }
  } catch {}
}

/** Append any NEW log lines for `name` into its persistent file. */
async function capture(name) {
  try {
    const meta = readMeta(name);
    const args = ['logs', '--timestamps'];
    if (meta.lastTs) args.push('--since', String(meta.lastTs / 1000));
    args.push(name);
    const r = await runCmd('docker', args, { timeout: 20000 });
    if (r.code !== 0) return; // container gone / not ours — nothing to capture

    const all = (r.stdout + '\n' + r.stderr).split('\n');
    const parsed = [];
    let last = meta.lastTs || 0;
    for (const line of all) {
      // Skip blank/whitespace-only lines. Without this, an empty `docker logs
      // --since` run (quiet container) yields ['', ''] from the stdout/stderr
      // separator and appends two blank lines to the file every capture.
      if (!line.trim()) continue;
      const m = /^(\S+)\s/.exec(line);
      if (!m) { parsed.push({ ts: null, text: line }); continue; }
      const ts = Date.parse(m[1]);
      if (Number.isNaN(ts)) { parsed.push({ ts: null, text: line }); continue; }
      parsed.push({ ts, text: line });
    }
    // Chronological order, then drop anything already captured.
    parsed.sort((a, b) => (a.ts == null ? 1 : b.ts == null ? -1 : a.ts - b.ts));
    const kept = [];
    for (const p of parsed) {
      if (p.ts == null || p.ts > last) {
        kept.push(p.text);
        if (p.ts) last = Math.max(last, p.ts);
      }
    }
    if (!kept.length) return;

    fs.mkdirSync(logDir(name), { recursive: true });
    fs.appendFileSync(logFile(name), kept.join('\n') + '\n');
    meta.lastTs = last;
    writeMeta(name, meta);
    trim(name);
  } catch {}
}

/** Last `tail` lines of the persistent file for `name`. */
function readLogs(name, tail = 500) {
  try {
    const f = logFile(name);
    if (!fs.existsSync(f)) return '';
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-tail).join('\n');
  } catch {
    return '';
  }
}

/** Sweep helper: capture every still-existing container at once. */
async function captureAll(containerNames) {
  await Promise.all(containerNames.map((n) => capture(n)));
}

module.exports = { capture, captureAll, readLogs, logFile };
