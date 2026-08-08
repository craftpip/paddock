# Health Checkup

The container health checkup lives in the **Settings tab** (it replaced the old
dedicated Health tab, which was removed in the SPA migration). It is a
driver-agnostic Docker-level checkup, not an app-level one.

> Last updated: 2026-08-09

## What it does

`src/services/container-health.js` diffs the **declared** compose settings
(`docker compose -f instances/<name>/docker-compose.yml config --format json`)
against the **actual** container (`docker inspect`). It works on stopped
containers too — while down it reports *why* (exit code, OOM-kill, stale
network peer) instead of failing.

**11 checks:** compose file · container exists/status (with OOM/exit-code
reason) · Docker `/healthz` probe · restart policy · image · network mode +
`container:` peer existence/running state · volumes/bind mounts (incl.
`/workspace` host-path split-brain detection) · docker socket mount · published
ports · env keys (secrets excluded via `/(password|token|key|secret)/i`).

Each check: `{ key, label, status: 'ok'|'warn'|'error', expected, actual, hint }`.
`checkContainerHealth(name, onCheck?)` — with `onCheck` streams per-check
(health job); without it returns the full report. `summarize()` derives status:
error if any, else warn if any, else ok.

**No auto-fix** — failing rows carry a hint (usually "Recreate to fix"). The
dashboard Start button already falls back to compose recreate when `docker
start` fails.

## UI (Settings tab)

- **Run Health Check** button → SSE job (`health:<name>`) streaming each check
  into a live popup (`HealthCheckModal.jsx`): ✓/✗/~ rows with expected/found
  detail, hints, and a counts footer.
- **Status pill** — last passive report from `GET /api/agents/:name/health`;
  click reopens the full report.
- **Stale network peer banner** — compose routes through a `container:` peer
  that was recreated (`stale`) or is stopped (`peer-stopped`): amber banner with
  a **Recreate to fix** button (`POST /api/agents/:name/recreate`).

## API

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/agents/:name/health` | Passive full report `{ name, status, checks, counts }` |
| POST | `/api/agents/:name/health-check` | 202 + job `health:<name>` streaming `check` events, finishes with `{ status, counts }` |
| GET | `/api/agents/:name/health-log` | SSE of `check`/`done`/`error` events, replays after `since`/`Last-Event-ID` |
| POST | `/api/agents/:name/recreate` | 202 + job `recreate:<name>` — force-recreate, the standard fix |

## Components

- `src/client/src/pages/agent/SettingsTab.jsx` — health section (Run button,
  pill, stale-peer banner)
- `src/client/src/components/HealthCheckModal.jsx` — the streaming checklist
  popup (rows use `items-center` so the icon centers against the label text)
- `src/services/container-health.js` — the checkup engine

Driver-aware app checks are planned but not implemented — see
`plans/20-health-check-driver-aware.md` (per-driver `healthChecks` group:
openclaw cron/gateway/models, hermes config.yaml/model, picoclaw
gateway/config, codex login, generic config-file parse).
