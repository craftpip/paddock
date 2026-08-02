# Create Agent — Live Build/Up/Clone/Setup Terminal

**Date:** 2026-08-02
**Status:** Plan

## Goal

Make Create Agent transparent. When the user creates an agent, show the **real terminal output** of every step on the create page instead of the current fake spinner steps. When it's done, move the user along.

## What the user sees

- Create form (name, agent type, clone-from-backup select) stays as-is.
- On submit, the form area is replaced by a live log pane that streams the actual commands and their output.
- Steps are clearly labeled as they start:
  - **Build** — `docker compose build` output
  - **Up** — `docker compose up -d` output
  - **Clone** (only when a backup was selected) — backup restore output (`docker cp`, `tar -xzf`, `docker restart`)
  - **Setup** (only for fresh, no-clone installs) — `openclaw setup` output inside the container
- When everything finishes:
  - **Clone path:** auto-navigate to the agents page (`/agents`).
  - **Fresh path:** stay on the create page. Show a "Go to Agents" button so the user can scroll the logs at their own pace and leave when ready. No auto-navigation.

## Why fresh behaves differently

A fresh install is not "ready" the moment the container is up — openclaw's workspace (`openclaw setup` creates the workspace/session dirs) still has to be initialized. So for fresh installs we run `openclaw setup` as part of the flow and show its output, then hand control to the user.

## Current state (what we're replacing)

- `src/client/src/pages/CreateAgent.jsx` — posts to `/api/agents/create`, shows **fake** progress steps (`progressSteps` array + hardcoded `setTimeout` delays). No real output.
- `src/app.js:1267` — `POST /api/agents/create` is **blocking**: `vm.createVm()` then `backup.restoreAgent()` run synchronously and the response only arrives when everything is done. No way to stream.
- `src/services/vm-manager.js:95` — `createVm()` does: workspace dir + meta.env + compose write, then `docker compose up -d` (build happens implicitly inside), then `docker exec <name> openclaw setup` (retries 15x), then `docker restart`. Uses `execFile` via `runCmd()` — no streaming.
- `src/services/backup-manager.js:73` — `restoreAgent()`: `docker cp` backup in, `tar -xzf` to data dir, `docker restart`. Also non-streaming.

## Flow

```
User clicks Create
        │
        ▼
POST /api/agents/create ──► returns 202 immediately, starts background job
        │
        ▼
Frontend opens SSE stream: GET /api/agents/:name/create-log
        │
        ▼
  step 1: BUILD   ── docker compose -f <instance-compose> build
  step 2: UP      ── docker compose -f <instance-compose> up -d
        │
        ├── clone path (backup_file set)
        │     step 3: RESTORE ── docker cp + tar -xzf + docker restart
        │     step 4: DONE ── auto navigate("/agents")
        │
        └── fresh path (no backup_file)
              step 3: SETUP ── docker exec <name> openclaw setup (with wait+retry)
              step 4: RESTART ── docker restart <name>
              step 5: DONE ── show "Go to Agents" button, user navigates when ready
```

## Backend changes

### 1. Job log store (new service)

New module `src/services/job-log.js` — a small in-memory event store:

- `createJob(name)` — register a job, returns a sink.
- `append(job, { stream: 'stdout'|'stderr'|'system', text })` — push a line, bump an incrementing index, keep an array of recent lines (for replay).
- `setStep(job, step, state)` — `state: 'start'|'end'|'error'`.
- `finish(job, ok)` / `fail(job, err)`.
- Subscribers list per job for SSE fan-out; jobs cleaned up after a few minutes.

In-memory is fine (single-user panel). A create in flight during a server restart is lost — acceptable, note it.

### 2. Streaming command runner

`vm-manager.js` already has `runCmd()` (execFile, no streaming). Add `runCmdStream(cmd, args, { onLog })` built on `spawn` that feeds every chunk of stdout/stderr through `onLog`. The create job wires `onLog` to the job store.

### 3. Rework `createVm` to emit steps + stream

`createVm(name, { agent, mode, cloneSource, onLog, onStep })`:

- Emit `prepare` line for the host-side setup (workspace dir, meta.env, compose write) — quick, one line each.
- **Build as its own step**: run `docker compose -f <path> build` explicitly first so the user sees the build output isolated, instead of it being hidden inside `up -d`. Generous timeout (build installs apt packages, can take minutes).
- **Up as its own step**: `docker compose -f <path> up -d`.
- Only run the `openclaw setup` + restart block when `mode !== 'clone'` (fresh). In clone mode the restore brings the config/workspace, so the setup run is skipped.

### 4. New API routes (`src/app.js`)

Replace the blocking `POST /api/agents/create` (line 1267):

```js
POST /api/agents/create
  body: { name, agent, backup_file, assign_to }
  → 202 { ok: true, job: name }        // starts background job, returns immediately
```

Background job (setImmediate, like routes/agents.js does today):
1. `createVm(name, { agent, mode: backup_file ? 'clone' : 'fresh', onLog, onStep })`
2. if `backup_file`: stream `backup.restoreAgent(name, backup_file)` (make it accept `onLog` too)
3. owner assignment in DB (keep existing logic)
4. `registry.dockerPsList(true)`, `finish(job, true)`
5. on error: `fail(job, err)` — frontend shows the error in the log pane, stays on page.

New GET routes:

```js
GET /api/agents/:name/create-log?since=<index>
  → SSE stream:
      event: step    data: { step: 'build'|'up'|'restore'|'setup'|'done', state: 'start'|'end'|'error' }
      event: line    data: { n: <index>, stream: 'stdout'|'stderr'|'system', text: '...' }
      event: done    data: { ok: true, name }
      event: error   data: { message }

GET /api/agents/:name/create-status
  → { step, state, done, failed, lineCount }   // polling fallback / reconnect recovery
```

SSE notes:
- Auth via session cookie (same-origin), no CSRF needed (GET, no side effects).
- On connect with `since=<n>`, replay buffered lines after `n` so a dropped connection catches up.
- Keep-alive comment every ~15s so proxies don't kill the stream during a long build.

Why SSE instead of WebSocket: the existing `/ws/terminal/:name` handler rejects connections when the container isn't running yet — the exact window we need to stream during (build happens before the container exists). SSE is one-way, auto-reconnects with `Last-Event-ID`, and needs no changes to the wss handler. The `Console.jsx` component is already built for this kind of read-only line feed.

## Frontend changes (`src/client/src/pages/CreateAgent.jsx`)

- Rip out the fake `progressSteps` spinner block.
- Add a live log pane using the existing **`Console`** component (`src/client/src/components/Console.jsx`) — it's already a line/command/step logger and currently orphaned (see `plans/reconstruction.md`). Feed it SSE lines; render step headers as command lines.
- New `useCreateStream()` hook (or inline logic) that:
  - POSTs `/api/agents/create`, then opens the SSE stream on `/api/agents/:name/create-log`.
  - Reconnects with `?since=<lastIndex>` on drop (and falls back to polling `/create-status` if SSE won't reconnect).
  - Tracks `step`, `running`, `done`, `failed` state.
- **Clone path done:** small "Agent created — taking you to the dashboard" banner, then `navigate('/agents')` after ~1.5s.
- **Fresh path done:** success banner + prominent **"Go to Agents"** button. No auto-nav. The log pane stays scrollable underneath.
- **Failure:** log pane shows the error tail, red banner, button to go back to the form (reset state) or retry. Never navigate on failure.
- Disable the form fields while a create is running; a running create keeps the user on the page.
- `Ctrl+N` shortcut already routes to Create Agent (shortcuts.js) — no change needed.

## Edge cases

- **Long build** (apt install in `vm-builds/*/Dockerfile`): `runCmdStream` needs a long timeout (~900s) for build. Show the live progress; SSE keep-alives prevent proxy timeouts.
- **Container not ready for `openclaw setup`:** keep the existing 15x retry, but emit a `Waiting for container…` system line between attempts so the user isn't staring at silence.
- **Name collision / invalid name:** validate before starting the job (already done), return 400/409 synchronously — no job, no log.
- **Server restart mid-create:** in-memory job lost; `/create-status` returns `done: false` then job vanishes. Frontend shows a "connection lost" line and returns to form. Acceptable for now.
- **Build/up failure:** `fail(job)` — frontend stays on page, shows error, no navigation. The user can inspect logs and retry.

## Out of scope (for reference only)

The user described a future Dashboard feature — **not** part of this plan:

> When a fresh agent lands on the Dashboard with no backup imported, detect whether openclaw has been initialized in that container. If not, show a "Run initialize" button. Clicking it runs the init command (creates workspace dirs inside the container) and streams the output.

That is a separate piece of work on the Dashboard. This plan only covers the Create Agent flow.

## Files touched

- `src/services/job-log.js` — **new**, in-memory job/event store
- `src/services/vm-manager.js` — `runCmdStream()`, `createVm()` emits steps + streams, build as separate step, skip setup on clone
- `src/services/backup-manager.js` — `restoreAgent()` accepts `onLog`
- `src/app.js` — `POST /api/agents/create` returns 202 + background job; new SSE + status routes
- `src/client/src/pages/CreateAgent.jsx` — live log pane, SSE hook, done/failure states, fresh-vs-clone navigation
- `src/client/src/components/Console.jsx` — wire it up (currently orphaned)
