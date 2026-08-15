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
 * timestamp. We retain that full timestamp (not JavaScript's millisecond
 * representation) and the lines at its boundary in `meta.json`. Because Docker
 * log timestamps come from the host clock and are monotonic per container, a
 * freshly-recreated container's logs all sort after the previous container's,
 * so the file becomes one continuous stream — no dupes, no gaps.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ensureOwned } = require('./ownership');

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
    ensureOwned(logDir(name));
    fs.writeFileSync(metaFile(name), JSON.stringify(meta));
    ensureOwned(metaFile(name));
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

/** Return only Docker log lines not represented by the saved timestamp cursor.
 * Docker uses fixed-width RFC3339Nano timestamps, so string ordering preserves
 * the nanosecond precision that Date.parse would discard. */
function newLinesFromDockerOutput(output, meta) {
  const parsed = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const m = /^(\S+)\s/.exec(line);
    if (!m || Number.isNaN(Date.parse(m[1]))) {
      parsed.push({ ts: '', text: line });
    } else {
      parsed.push({ ts: m[1], text: line });
    }
  }
  parsed.sort((a, b) => (a.ts ? (b.ts ? a.ts.localeCompare(b.ts) : -1) : 1));

  const previous = typeof meta.lastTs === 'string' ? meta.lastTs : '';
  let last = previous;
  let boundaryLines = new Set(previous ? meta.lastTsLines || [] : []);
  const lines = [];
  for (const entry of parsed) {
    if (!entry.ts) {
      lines.push(entry.text);
    } else if (entry.ts > last) {
      last = entry.ts;
      boundaryLines = new Set([entry.text]);
      lines.push(entry.text);
    } else if (entry.ts === last && !boundaryLines.has(entry.text)) {
      boundaryLines.add(entry.text);
      lines.push(entry.text);
    }
  }
  return { lines, lastTs: last, lastTsLines: [...boundaryLines] };
}

/** Append any NEW log lines for `name` into its persistent file. */
async function capture(name) {
  try {
    const meta = readMeta(name);
    const args = ['logs', '--timestamps'];
    const migratingMillisecondCursor = typeof meta.lastTs === 'number' && meta.lastTs > 0;
    if (meta.lastTs) {
      // Replay one second when upgrading the old millisecond cursor so lines
      // previously collapsed into its final millisecond can be recovered.
      const since = migratingMillisecondCursor
        ? Math.max(0, meta.lastTs - 1000) / 1000
        : meta.lastTs;
      args.push('--since', String(since));
    }
    args.push(name);
    const r = await runCmd('docker', args, { timeout: 20000 });
    if (r.code !== 0) return; // container gone / not ours — nothing to capture

    const next = newLinesFromDockerOutput(r.stdout + '\n' + r.stderr,
      migratingMillisecondCursor ? { lastTs: 0 } : meta);
    if (migratingMillisecondCursor) {
      try {
        const existing = new Set(fs.readFileSync(logFile(name), 'utf8').split('\n'));
        next.lines = next.lines.filter((line) => !existing.has(line));
      } catch {}
    }
    if (!next.lines.length && !migratingMillisecondCursor) return;

    fs.mkdirSync(logDir(name), { recursive: true });
    ensureOwned(logDir(name));
    if (next.lines.length) {
      fs.appendFileSync(logFile(name), next.lines.join('\n') + '\n');
      ensureOwned(logFile(name));
    }
    meta.lastTs = next.lastTs;
    meta.lastTsLines = next.lastTsLines;
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

module.exports = { capture, captureAll, readLogs, logFile, newLinesFromDockerOutput };
