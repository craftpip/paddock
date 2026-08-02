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

function scheduleCleanup(name) {
  setTimeout(() => {
    const job = jobs.get(name);
    if (job && job.subs.size === 0) jobs.delete(name);
  }, CLEANUP_MS);
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
  };
  jobs.set(name, job);
  return job;
}

function getJob(name) {
  return jobs.get(name);
}

function getOrCreateJob(name) {
  return jobs.get(name) || createJob(name);
}

function append(job, event) {
  event.n = job.events.length;
  event.ts = new Date().toISOString();
  job.events.push(event);
  if (event.type === 'step') job.step = event.step;
  if (event.type === 'done') { job.done = true; job.state = 'done'; }
  if (event.type === 'error') { job.failed = true; job.state = 'failed'; job.error = event.message; }
  for (const sub of job.subs) {
    try { sub.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); } catch {}
  }
  return event.n;
}

function setStep(job, step, state) {
  return append(job, { type: 'step', step, state });
}

function line(job, stream, text) {
  return append(job, { type: 'line', stream, text });
}

function finish(job, ok = true) {
  const n = append(job, { type: 'done', ok, name: job.name });
  scheduleCleanup(job.name);
  return n;
}

function fail(job, message) {
  const n = append(job, { type: 'error', message });
  scheduleCleanup(job.name);
  return n;
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
      try { res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`); } catch {}
    }
  }
  res.on('close', () => job.subs.delete(res));
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

module.exports = {
  createJob,
  getJob,
  getOrCreateJob,
  append,
  setStep,
  line,
  finish,
  fail,
  subscribe,
  getStatus,
};
