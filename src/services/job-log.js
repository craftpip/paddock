/**
 * In-memory job log store for long-running operations (create agent, ...).
 *
 * A job holds an ordered list of events and a set of SSE subscriber response
 * objects. Lines are appended as they stream in; subscribers are fanned out
 * immediately, and late/reconnecting subscribers get a replay via the `since`
 * index on the SSE route.
 *
 * Events look like:
 *   { n, ts, type: 'step'|'line'|'done'|'error', step?, state?, stream?, text?, message?, ok?, name? }
 *
 * Jobs are cleaned up 5 minutes after they finish (only if no subscriber is
 * still attached).
 */

const jobs = new Map();

const CLEANUP_MS = 5 * 60 * 1000;

function scheduleCleanup(job) {
  // unref'd + tracked on the job: a pending cleanup must never hold the process
  // open (it would delay shutdown by up to 5 min), and clearJob cancels it.
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(() => {
    const live = jobs.get(job.name);
    if (live && live.subs.size === 0) jobs.delete(job.name);
  }, CLEANUP_MS);
  if (typeof job.cleanupTimer.unref === 'function') job.cleanupTimer.unref();
}

function createJob(name) {
  const job = {
    name,
    events: [],
    subs: new Set(),
    step: null,
    state: 'running',
    done: false,
    failed: false,
    error: '',
    ts: Date.now(),
    cleanupTimer: null,
  };
  jobs.set(name, job);
  return job;
}

function getJob(name) {
  return jobs.get(name);
}

function getOrCreateJob(name) {
  const existing = jobs.get(name);
  if (existing && existing.state === 'running') return existing;
  return createJob(name);
}

function clearJob(name) {
  const job = jobs.get(name);
  if (job && job.cleanupTimer) clearTimeout(job.cleanupTimer);
  jobs.delete(name);
}

function append(job, event) {
  event.n = job.events.length;
  event.ts = new Date().toISOString();
  job.events.push(event);
  if (event.type === 'step') job.step = event.step;
  if (event.type === 'done') { job.done = true; job.state = 'done'; }
  if (event.type === 'error') { job.failed = true; job.state = 'failed'; job.error = event.message; }
  for (const sub of job.subs) {
    try { sub.write(encodeEvent(event)); } catch {}
  }
  return event.n;
}

function encodeEvent(event) {
  return `event: ${event.type}\nid: ${event.n}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Attach an SSE response to a job and replay events after `since`. */
function subscribe(job, res, since = 0) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  job.subs.add(res);
  for (const ev of job.events) {
    if (ev.n >= since) {
      try { res.write(encodeEvent(ev)); } catch {}
    }
  }
  // Keep-alive so proxies don't drop the stream during long quiet builds.
  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { clearInterval(keepAlive); }
  }, 15000);
  res.on('close', () => {
    clearInterval(keepAlive);
    job.subs.delete(res);
  });
}

function setStep(job, step, state, cmd) {
  const ev = { type: 'step', step, state };
  if (cmd) ev.cmd = cmd;
  return append(job, ev);
}

function line(job, stream, text) {
  return append(job, { type: 'line', stream, text });
}

/** Stream a health-check result item. Shape matches container-health checks:
 *  { key, label, status: 'ok'|'warn'|'error', expected?, actual?, hint? } */
function check(job, item) {
  return append(job, { type: 'check', ...item });
}

function finish(job, ok = true, extra = {}) {
  const n = append(job, { type: 'done', ok, name: job.name, ...extra });
  scheduleCleanup(job);
  return n;
}

function fail(job, message) {
  const n = append(job, { type: 'error', message });
  scheduleCleanup(job);
  return n;
}

/** Simple polling fallback status. Returns null if the job is gone. */
function getStatus(name) {
  const job = getJob(name);
  if (!job) return null;
  return {
    name: job.name,
    step: job.step,
    state: job.state,
    done: job.done,
    failed: job.failed,
    error: job.error,
    lineCount: job.events.length,
  };
}

/** Every live job, newest first. `prefix` filters by job-key prefix; used to
 *  resolve "which jobs belong to this PAD" (`<name>` = create, `update:<name>`
 *  = recreate/update, `health:<name>` = health check). */
function listJobs(prefix = '') {
  return [...jobs.values()]
    .filter((j) => j.name.startsWith(prefix))
    .sort((a, b) => b.ts - a.ts)
    .map((j) => ({ ...getStatus(j.name), ts: j.ts }));
}

/** The rendered log lines of a job: `{stream, text}` events become
 *  `[stream] text` strings, matching what the create/recreate tools return in
 *  their `log` array. `tail` limits to the last N (default 50, max 2000). */
function logLines(name, { tail = 50, since = 0 } = {}) {
  const job = getJob(name);
  if (!job) return null;
  const out = [];
  for (const ev of job.events) {
    if (ev.n < since) continue;
    if (ev.type === 'line') out.push(`[${ev.stream || 'line'}] ${ev.text || ''}`);
    else if (ev.type === 'step') out.push(`[step] ${ev.step} ${ev.state}${ev.cmd ? ` — ${ev.cmd}` : ''}`);
  }
  const n = Math.max(1, Math.min(Number(tail) || 50, 2000));
  return out.slice(-n);
}

module.exports = {
  createJob,
  getJob,
  getOrCreateJob,
  clearJob,
  append,
  setStep,
  line,
  check,
  finish,
  fail,
  subscribe,
  getStatus,
  listJobs,
  logLines,
};
