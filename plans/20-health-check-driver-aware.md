# Driver-Aware Health Checks (plan 20 — 2026-08-07, future work)

## Status: Proposed (not started, 2026-08-09) — design complete, 0%
implemented. The driver-agnostic container-level check layer ships; the
driver-aware `healthChecks` layer is not built.

## Context

`src/services/container-health.js` ships a generic, driver-agnostic Docker-level
checkup (status, health probe, restart policy, image, network peer, volumes,
docker socket, ports, env). It is intentionally container-only for now. This
plan extends it with **driver-aware checks** so each agent type (openclaw,
picoclaw, hermes, codex, …) reports on its own app-level state too.

Current container-level checks (keep these as the base layer):

- Container exists / status (with OOM-kill + exit-code reason)
- Docker healthcheck probe (`/healthz`)
- Restart policy vs compose
- Image (declared vs actual)
- Network mode + `container:` peer existence / running state
- Volumes / bind mounts (incl. `/workspace` split-brain detection)
- Docker socket mount
- Published ports
- Environment keys (secrets excluded)

## Goal

Add a second layer of checks driven by `getDriver(agent)` — one optional
`healthChecks` group per driver — and stream them in the same health-check job
and popup (`HealthCheckModal.jsx`). No new UI surface: the popup already renders
every check it receives over the `check` SSE event.

## Design

### Driver field: `healthChecks`

Add an optional `healthChecks` array to `src/services/drivers/<type>.js`.
Each item:

```js
{
  key: 'cron',                       // unique within the driver
  label: 'Cron jobs running',        // shown in the popup
  run: async (name) => ({            // returns the check result
    status: 'ok' | 'warn' | 'error',
    expected: '...',
    actual: '...',
    hint: '...',
  }),
}
```

`run(name)` executes inside the container via `docker exec` (use `runCmd` from
`cmd.js`, not a TTY). On exception → `{ status: 'error', hint: e.message }`.
Drivers with no `healthChecks` get none — the container layer alone still runs.

### Service wiring (`container-health.js`)

- `checkContainerHealth(name, onCheck)` takes an optional `{ agent }`/`{ type }`
  option so it can resolve `getDriver(type).healthChecks`.
- App-level checks run **after** the container-level ones and are skipped with a
  `warn` "container not running — skipped app checks" row when the container is
  down (don't `docker exec` a dead container).
- Container-level checks that already overlap a driver check stay generic (the
  driver layer does NOT replace the base layer).

### Route changes (`app.js`)

`/api/agents/:name/health` and `/api/agents/:name/health-check` already call
`checkContainerHealth(name)`. Pass the agent through:

```js
const agent = registry.getAgent(name);   // or readMeta(name)
containerHealth.checkContainerHealth(name, onCheck, { agent })
```

Both routes already carry the full agent context — no new endpoints.

### Suggested per-driver checks

- **openclaw**: cron jobs present + healthy (`openclaw cron list`), gateway
  reachable (`openclaw gateway status` or socket check), auth/model configured
  (`openclaw models status`), memory index exists when `memorySearch` configured.
- **picoclaw**: gateway listening (`picoclaw gateway` process check),
  config.json valid + model/provider set.
- **hermes**: config.yaml exists + `model.provider`/`model.default` set,
  gateway running (pid/liveness), cron config (`hermes cron list`).
- **opencode / codex / claude**: config file exists, model configured, (codex)
  auth/login present.
- Generic fallback: config file exists and parses (`driver.configFile` +
  `driver.configFormat`), workspace dir exists.

### UI (`HealthCheckModal.jsx`)

No structural change needed — rows already render arbitrary keys, labels, hints,
and expected/found detail. Optionally group app-level rows under a
"Driver checks (type)" subheader, and add a small tag on the summary badge if a
driver check failed. The pill on Settings stays derived from the full report.

## Files touched (when implemented)

- `src/services/container-health.js` — driver-aware layer, agent opt-in
- `src/services/drivers/*.js` — `healthChecks` arrays per type
- `src/app.js` — pass agent into health routes
- `src/client/src/components/HealthCheckModal.jsx` — optional subheader/grouping
- `docs/tabs/settings.md`, `docs/backend/services.md` — document driver checks

## Acceptance

1. A healthy pad of each type shows all container + app checks ✓.
2. A broken app (e.g. missing config.yaml, model unset) shows a ✗ with a useful
   hint for hermes/picoclaw/codex without the container layer passing wrongly.
3. Stopped containers still report cleanly (container ✗ + "skipped app checks").
4. `services.test.js` + `mcp.test.js` still pass.
