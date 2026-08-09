# Create Agent Options — Docker, Network, Extra Volumes, Extra Ports (plan 28)

## Status: Proposed (not started, 2026-08-09) — 0/4 phases implemented.
Current-behavior mapping (2026-08-08) + design complete; backend
storage/compose, create endpoint + form, Settings volumes, and Web/ports all
pending.

## Goal

Turn the Create Agent page (`/agents/create`) into the full options form it was
always meant to be. At create time the user can set, alongside the existing
name/type/custom-workspace:

1. **Allow docker in the container** — the docker.sock bind + docker CLI build
   arg (already exists in Settings; surface it at create).
2. **Network** — route the agent through another running container via
   `network_mode: container:` (already exists in Settings; surface it at
   create).
3. **Additional volumes** — an arbitrary list of extra host→container bind
   mounts beyond the data dir / workspace.
4. **SSH port** — optionally expose OpenSSH on a host port.
5. **Additional ports** — an arbitrary list of host→container port mappings
   independent of the optional SSH port.

Post-create management:

- **Additional volumes** are listed and editable in the **Settings** tab (a new
  "Additional volumes" card, same SSE-job + recreate flow as custom workspace).
- **Additional ports** are listed and editable in the **Web** tab (the tab
  becomes "Web & Ports"; a new section shows the declared port mappings).

## Current behavior (verified 2026-08-08)

- Create form (`CreateAgent.jsx`) posts only `name`, `agent`, `workspace_host`,
  `workspace_dir` to `POST /api/agents/create` (`app.js:2245`), which passes
  `workspaceHost`/`workspaceDir` into `createVm()` (`vm-manager.js:633`).
- `createVm()` writes `meta.env` (ROOT_PASSWORD, AGENT, PORT,
  WORKSPACE_HOST/WORKSPACE_DIR) then `writeInstanceCompose(name, agent, pw,
  finalPort)` (`vm-manager.js:742-749`) with **no opts** — so created agents
  never get the docker bind or a network peer.
- `generateInstanceCompose()` (`vm-manager.js:327`) already emits: data-dir bind
  (+ custom workspace bind + working_dir + optional docker.sock), the SSH port,
  the web app port/door, and `network_mode: container:` when `opts.network`.
  It reads meta via `readWorkspaceMount(name, agent)` — the same sticky pattern
  extra volumes/ports will use.
- `applySettings()` (`vm-manager.js:443`) regenerates compose with
  `{ allowDocker, network, webService, webPeerNetwork }` and writes `DOCKER` /
  `NETWORK` meta flags. Callers pass every field explicitly (it does NOT fall
  back to stored values for allowDocker/network).
- Settings GET (`app.js:789`) returns `{ allowDocker, network, image, version,
  networkHealth, workspaceMount }`; Settings POST (`app.js:855`) validates,
  regenerates, recreates via an SSE job.
- Web GET (`app.js:1146`) returns the built-in web app binding + `actualPorts`
  (from `docker inspect .NetworkSettings.Ports`); Web POST (`app.js:1199`)
  publishes/unpublishes the built-in app through `applyWebServices`.
- `hostPortInUse(hostPort, excludeName)` (`app.js:1096`) already exists for
  port-conflict checks.
- **Pre-existing bug noticed while mapping the flow:** `resetVm()`
  (`vm-manager.js:831`) regenerates the compose with
  `writeInstanceCompose(name, agent, pw, port)` — no opts — so a reset silently
  drops an existing docker bind and network peer. We are touching this exact
  code path; fix it here. Reset must preserve the complete persisted binding
  set: Docker, network, SSH, web, extra volumes, and extra ports.

## Design

### Storage — `meta.env` flags

Two new single-line JSON flags (same mechanism as `WORKSPACE_HOST`; `readMeta`
splits on the first `=`, so embedded `:` / `,` / `"` are safe, and newlines
never occur in `JSON.stringify` output):

```
EXTRA_VOLUMES=[{"host":"/mnt/data","container":"/data","readonly":false}]
EXTRA_PORTS=[{"host":8080,"container":8080}]
```

- **EXTRA_VOLUMES**: array of `{ host, container, readonly }`. `host` is an
  absolute path (or `instances/<name>/…` under the project root). `readonly`
  emits `:ro` on the bind.
- **EXTRA_PORTS**: array of `{ host, container }`, TCP only (v1).

Both are read by `generateInstanceCompose` from meta (sticky across every regen
path — create, settings, web, ports, update, `ensureInstanceBuilds` migration)
so existing callers need no change. `instances/*` is gitignored, so the JSON
never lands in git.

### Compose generation (`generateInstanceCompose`)

- Extra volumes append to the `volumes:` block after the data-dir bind, custom
  workspace, and docker.sock lines. Each is emitted as one quoted scalar via the
  existing `yamlScalar()` helper:
  `- "/mnt/data:/data"` or `- "/mnt/data:/data:ro"`.
- Extra ports append to the `ports:` block after the SSH + web-app ports:
  `- "8080:8080"`.
- **Peer-mode hard rule (unchanged):** when `network_mode: container:` is set,
  Docker refuses port publishing entirely. The ports block (SSH included) is
  already skipped in that mode. Extra ports in peer mode are **rejected at
  validation time** with a clear error ("Docker cannot publish ports while this
  agent joins <peer>'s network — clear the network override or remove the extra
  ports"). The built-in web app keeps its existing socat-door exception; extra
  port doors are documented as a possible future phase (see Out of scope).
- Volumes are create-time config, so every volume/port change requires a
  recreate (same as the existing docker/network/workspace toggles).

### Validation (`vm-manager.js`)

New exports, modeled on `validateWorkspaceMount` (reusing the same
`HOST_SYSTEM_DIRS` / `CONTAINER_PROTECTED` guard lists):

- `validateExtraVolume(name, agent, host, container, readonly)` → normalized
  `{ host, container, readonly }` or throws. Host: absolute or
  `instances/<name>/…`; no control chars / quotes / backslashes / `:` / `.`/
  `..` segments; not `/`; not a system dir; not project root / `src` /
  `instances`; not another agent's folder; not a parent-or-self of this agent's
  data dir. Existing host paths under the project root must also be checked for
  symlink escape, using the same nearest-existing-ancestor rule as workspace
  mounts. Container: absolute; not `/`; not a protected system path; not a
  parent-or-self of `driver.dataDir` (descendant subfolders ARE allowed — e.g.
  mounting external storage at `/root/.openclaw/data/extra` is legit).
- `validateExtraPorts(ports, { sshPort, webHostPort, hostPortInUse })` →
  normalized array or throws. Each host/container must be an int 1–65535; no
  duplicate host ports among themselves; host ≠ agent SSH port; host ≠ web app
  host port; host not used by another agent (reuses `hostPortInUse` from the
  route layer — keep the async check in `app.js`, not the pure validator).

New readers (never throw, corrupt/stale JSON → `[]`):
`readExtraVolumes(name)`, `readExtraPorts(name)`.

### `createVm()` changes

New options: `allowDocker`, `network`, `sshEnabled`, `port`, `extraVolumes`,
`extraPorts`.

1. Validate network peer (must exist, be running, not self — mirror the
   settings route check) and extra volumes/ports BEFORE any file/dir is written.
   The route performs the complete host-port availability check before returning
   `202`, covering the optional SSH port and every extra port together.
2. `meta.env` gains `DOCKER=1|0`, `NETWORK=<peer>`, `EXTRA_VOLUMES=<json>`,
   `EXTRA_PORTS=<json>`.
3. `seedBuildDir(name, agent, { installDocker: allowDocker })`.
4. `writeInstanceCompose(name, agent, pw, finalPort, { allowDocker, network })`.

### `applySettings()` changes

Add `opts.extraVolumes` and `opts.extraPorts` (each only written when
`!== undefined`, mirroring the workspace pattern). Write the flags BEFORE
`writeInstanceCompose`. Generate-Instance reads them from meta, so any existing
regen path preserves them for free.

### API changes (`app.js`)

- **`POST /api/agents/create`** — accept `allowDocker`, `network`, `sshEnabled`,
  `port`, `extraVolumes`, `extraPorts`. Validate everything up front (before
  the 202):
  network peer exists+running+not-self, extra volumes, extra ports (incl.
  `hostPortInUse` with the future name as exclude), and check the optional SSH
  host port and all extra host ports together. Pass through to `createVm`.
- **`GET /api/agents/:name/settings`** — add `extraVolumes` (and
  `extraPorts`, harmless to include) to the response.
- **`POST /api/agents/:name/settings`** — accept `extraVolumes`; diff against
  stored, fold into the `changed` gate, summary, and job; pass to
  `applySettings`.
- **`GET /api/agents/:name/web`** — add `extraPorts` (declared list from meta,
  each with declared `host`→`container`). Return this even when the driver has
  no built-in web application; built-in web publishing remains nullable and is
  independent of extra Docker port declarations.
- **New `POST /api/agents/:name/ports`** — body `{ extraPorts: [...] }` (full
  replace, like settings). Validates (self-conflicts + `hostPortInUse`),
  then runs the same SSE-job shape as settings: stop → `applySettings(name, {
  allowDocker: meta.DOCKER==='1', network: meta.NETWORK||'', extraPorts })` →
  force-recreate → done. Ports never touch `web.json` (the built-in web app is
  untouched by this route).

### Safety rule

Extra-volume host sources are **never deleted** by `removeVm()` — they are
arbitrary user directories (possibly a shared data drive); unlike the custom
workspace source (cleaned when under the project root), deleting them on agent
removal is too dangerous. Removing an extra-volume row only removes that bind
from `meta.env` and the generated compose file; it then recreates the agent.
The source directory remains untouched. Document this in the UI tooltip.

### Frontend

**CreateAgent.jsx** — four new cards on the idle form (above submit):

1. **Container options**: "Allow docker in the container" toggle + Network
   dropdown fed by `GET /api/containers` (empty option = default; show running
   containers; stopped peers marked). Mirrors the Settings tab UI.
2. **SSH port**: an "Expose SSH" toggle, disabled by default, with an optional
   host-port field. If enabled without a value, the existing automatic SSH-port
   allocation is used.
3. **Additional volumes**: dynamic row list (host source, container path,
   readonly checkbox) with + Add / ✕ remove, client-side validation hints
   reusing the create form's existing field-style checks.
4. **Additional ports**: dynamic row list (host port, container port) with
   + Add / ✕ remove.

Submit body adds `allowDocker`, `network`, `sshEnabled`, `port`, `extraVolumes`,
`extraPorts`.

**SettingsTab.jsx** — new **"Additional volumes"** card (#5c, after network,
before custom workspace): lists declared binds (`host → container` + readonly
badge), add/remove rows, and an "Apply volumes & recreate" button that POSTs
`{ extraVolumes }` and streams the SSE job (same pattern as
`handleWorkspaceSave`).

**WebTab.jsx** — new **"Additional ports"** section: lists declared mappings,
allows add/remove, and has an "Apply ports & recreate" button POSTing
`/api/agents/:name/ports`. These are declarations only; do not show a live/down
indicator for extra ports. The section must remain available for agent types
without a built-in web application. The built-in web application and its
primary exposed port remain managed separately.
**AgentDetail.jsx** — rename the tab label `Web` → `Web & Ports`.

## Phases

1. **Backend storage + compose**: meta readers/writers, validators, compose
   emission, `createVm`/`applySettings`/`resetVm` opts, bug fix for resetVm.
2. **Create endpoint + form**: `POST /api/agents/create` fields, CreateAgent
   cards.
3. **Settings volumes**: settings GET/POST `extraVolumes` + Settings tab card.
4. **Web/ports**: web GET `extraPorts`, new `/ports` route, Web tab section,
   tab rename.

## Files touched

- `src/services/vm-manager.js` — validators, readers, compose gen, createVm,
  applySettings, resetVm fix.
- `src/app.js` — create route, settings GET/POST, web GET, new ports route.
- `src/client/src/pages/CreateAgent.jsx`
- `src/client/src/pages/agent/SettingsTab.jsx`
- `src/client/src/pages/agent/WebTab.jsx`
- `src/client/src/pages/AgentDetail.jsx` (tab label)
- `src/test/vm-manager.test.js` and `src/test/services.test.js` — validator,
  compose, and API-related unit tests.

## Testing

- Unit (`src/test/vm-manager.test.js` and `src/test/services.test.js`):
  `validateExtraVolume` accepts/rejects system dirs, data-dir swallowing,
  quotes, and project-root symlink escapes; `validateExtraPorts` checks bounds,
  duplicate declarations, optional SSH conflicts, and built-in web-port
  conflicts; `generateInstanceCompose` emits extra volume/port lines and omits
  published ports in peer mode; removing an extra-volume declaration removes
  only the bind from regenerated compose while its host source remains
  untouched; reset regeneration preserves Docker, network, SSH, web,
  extra-volume, and extra-port settings.
- API tests: create validates all requested host ports together before the 202,
  settings updates extra volumes, the ports endpoint replaces extra ports, and
  agents without a built-in web app can still list and edit extra ports.
- Live (browser MCP at `http://10.69.1.164:6789`): create an agent with Docker
  on, optional SSH, one volume, and one extra port → verify `docker inspect`
  mounts/ports, compose file, and `meta.env`; Settings shows the volume and
  edits it (SSE job + recreate); Web & Ports shows the declared port and updates
  it; removing the declaration removes only the bind and leaves the external
  host directory untouched. Also verify peer-network rejection for extra ports
  and the built-in web app's existing door behavior separately.
- **Restart the webui after backend edits** (`docker compose restart
  paddock`); **rebuild the SPA** (`cd src/client && npm run build`) after JSX
  edits. Verify the class strings landed in `src/public/assets/index-*.js`
  before browser-testing.

## Out of scope (future phases)

- Extra-port **doors** in peer mode (a socat door per port, extending the
  existing `<name>-web` door pattern). v1 rejects the combination with a clear
  message.
- UDP port mappings, read-only toggle on ports, host-IP binding.
- Managing extra volumes from the Workspace tab's file browser (they are Docker
  binds only; source paths remain user-owned and are never deleted by PAD
  removal or by removing the bind).
