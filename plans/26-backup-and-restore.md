# Native Agent Backups And Restore (plan 26)

## Status: In progress (2026-08-09) — Pre-plan complete: generic tar backup
system fully removed (2026-08-08). Goals 0–5 (shared `/backup` folder +
manifest + Backups tab + native driver capabilities) 0/6 implemented.

## Goal

Paddock uses an agent's own documented backup and restore commands. It never
creates a generic archive of the agent data directory, never extracts a native
archive, and never clones a backup while creating a PAD.

Every PAD gets a **Backups** tab. Drivers without a documented native
backup/import workflow show that backup and restore are not natively available;
they do not receive a filesystem-archive fallback or backup actions.

## Research Result

Current official documentation establishes five distinct behaviors:

| Driver | Native backup | Native restore/import | Paddock outcome |
| --- | --- | --- | --- |
| OpenClaw | `openclaw backup create` | No documented full-archive restore command | Create, verify, download; restore unavailable |
| Hermes | `hermes backup` | `hermes import <archive>` | Full native backup and restore |
| OpenCode | `opencode export [sessionID]` | `opencode import <file>` | Session export/import only, not PAD backup |
| PicoClaw | None documented | None documented | Unsupported |
| Codex | None documented | None documented | Unsupported |

The current project drivers are exactly `openclaw`, `hermes`, `opencode`,
`picoclaw`, and `codex`. No Claude driver exists yet.

## Product Rules

- A driver declares the exact native operations it supports; Paddock does not
  assume that a create/export command implies whole-PAD restore support.
- Native archive bytes are never modified. Paddock copies the output file to
  the host backup folder under `<pad-name>_<native-file-name>`.
- Paddock records a sidecar manifest for ownership and UI metadata only. It
  does not inspect, checksum, recompress, extract, or manufacture the archive.
- Restores only run when the native CLI has a documented import/restore command.
- Backups and restores never run as part of PAD creation. Remove clone options
  and every `backup_file` create-flow path.
- A native full backup belongs to its source PAD. Cross-PAD import is out of
  scope unless a driver explicitly documents a compatible workflow in a later
  goal.
- The host backup folder is the sole Paddock-managed archive store and is not
  versioned by Git.

## Pre-plan - Remove The Existing Generic Backup System

**Status: DONE (2026-08-08).** The generic tar backup system is fully removed.
Create PAD has no clone/`backup_file` path, no live code executes `tar` or
archive extraction, the Backups pages show a maintenance empty state, all
generic backup API/MCP routes return 404, legacy archives in the project
`backups/` folder are untouched, and tests/build pass. Goal 0 (shared
`/backup` folder + manifest plumbing + Backups tab) can now proceed.

Complete this removal before adding the fixed `/backup` mount, driver
capabilities, or the new Backups tab.

The current implementation archives the driver's entire `dataDir` with `tar`,
copies it into the project backup directory, restores it by extracting over the
live data directory, and lets Create PAD clone from that archive. None of that
behavior remains after this pre-plan.

### Remove from Create PAD

- Remove the **Clone from backup** card from `CreateAgent.jsx`.
- Remove `backupFile`, backup fetching/filtering, clone labels, restore console
  step, and clone redirect behavior from the client.
- Stop sending `backup_file` in `POST /api/agents/create`.
- Remove `backup_file` validation, `isClone`, `skipSetup`, and
  `backup.restoreAgent()` from the backend create job. Fresh PAD creation
  always runs its normal driver setup steps.

### Remove from Existing Backup Pages And APIs

- Remove generic Create Backup, Restore, Download, and Delete actions from the
  current Global Backups page and legacy agent backup views.
- Remove the existing generic backup and restore routes from `app.js`:
  `POST /api/agents/:name/backups/create`, restore/download/delete routes, and
  the global generic backup list behavior. The replacement native routes are
  introduced only in Goal 0 after this removal is complete.
- Remove `backup-manager.js` functions that execute `tar`, extract archives, or
  assume every driver uses its `dataDir` as a backup format.
- Remove `backupTypeMarker` and generic backup filename parsing from all drivers
  and `app.js`.
- Remove MCP generic backup tools that call the deleted manager methods, or make
  them unavailable until the native capability-aware replacement is delivered.
- Keep old files in the existing project `backups/` directory untouched. The
  removal must not delete, move, or alter user backup data.

### Completion checks

1. Create PAD has no clone-from-backup controls and its request contains no
   `backup_file` field. **Done** — browser-verified; `/api/agents/create`
   no longer reads `backup_file`; built bundle has no backup refs.
2. No active source path executes `tar` or archive extraction for a PAD backup
   or restore. **Done** — `backup-manager.js` stubbed (throws unavailable);
   repo sweep clean.
3. Existing Backups pages no longer expose generic backup actions; a temporary
   empty/maintenance state is acceptable until Goal 0 provides the new tab.
   **Done** — `GlobalBackups.jsx`, `views/backups.ejs`,
   `views/agents/backups.ejs`, `views/agents/detail.ejs` all show maintenance
   state.
4. Legacy archive files remain on disk and are not served as restorable data.
   **Done** — `backups/` folder untouched; all old backup routes removed
   (live-verified 404).
5. Remove or update tests that assert the deleted generic backup behavior, then
   run the relevant backend and SPA test/build checks. **Done** —
   `mcp.test.js` updated; backend suites pass (db 3, registry 4, vm-manager
   15, workspace 11, auth 3, mcp 4); SPA built; webui restarted and
   browser-verified.

## Goal 0 - Shared Backup Folder And UI Plumbing

### Host folder

- The deployment chooses the host backup location directly in the webui bind
  mount. For example: `/mnt/ddrive/paddock-backups:/backup:rw`.
- `/backup` is the fixed Paddock container path. It is not configurable in the
  UI or through an environment variable.
- Do not fall back to `/workspace/backups` when the mount is absent. Disable
  backup actions with an actionable error that tells the administrator to mount
  a host backup directory at `/backup`.
- Validate `/backup` is writable before starting a job. Docker-on-Docker must
  never resolve or create a backup path itself.
- Keep existing project-local generic archives untouched. Mark them `legacy`
  and non-restorable; do not migrate or delete user data automatically.

### Driver contract

Replace `backupTypeMarker` with a capability descriptor. It models full native
archives separately from session-only export/import:

```js
backup: {
  kind: 'archive' | 'session' | 'none',
  create: { command, outputDirectory, outputFromJson },
  restore: { command, requiresRestart }, // omitted when unsupported
  extensions: ['.tar.gz'],
  notes: 'User-visible caveat',
}
```

`command` must be an argument-array builder, never an interpolated shell string.
The adapter validates every CLI-generated output path is inside the declared
container temporary directory before copying it to `/backup`.

### Manifest and jobs

Store `<prefixed-file>.paddock.json` beside every successful native file:

```json
{
  "format": 1,
  "file": "pad-hermes-demo_hermes-backup-2026-08-08.zip",
  "nativeFile": "hermes-backup-2026-08-08.zip",
  "pad": "pad-hermes-demo",
  "agentType": "hermes",
  "kind": "archive",
  "createdAt": "2026-08-08T14:32:10.000Z"
}
```

- Use reconnectable `backup:<pad>` and `restore:<pad>` job-log/SSE jobs.
- Stream the native CLI output into the existing Console modal.
- Never accept host paths, container paths, or arbitrary filenames from the
  browser. Resolve the archive through `/backup` and its manifest.
- On success, delete only the temporary copy Paddock placed in the agent
  container, in a `finally` block.
- Record create/restore/delete activity events without logging archive contents
  or secrets.

### Pages

- Add an agent-scoped `BackupsTab.jsx` and a `backups` mode in `AgentDetail.jsx`
  for every driver.
- The Global Backups page lists manifest-backed files with source PAD, driver,
  type, creation time, size, Download, Delete, and a link to the source PAD.
- Restore always lives on the source PAD Backups tab, never in global quick
  actions.
- Unsupported drivers show the exact message: **Backup and restore are not
  natively available for this agent type.**
- Remove Global Backups **Quick Backup** buttons. They bypass driver capability
  context and cannot represent unsupported/partial modes correctly.
- Remove Create PAD `backupFile` state, `/api/backups` fetch, clone selector,
  restore progress step, `backup_file` request field, backend clone branch, and
  setup-skipping behavior.

### Common API

- `GET /api/agents/:name/backups` returns records owned by the PAD plus the
  complete driver backup capability.
- `POST /api/agents/:name/backups/create` returns a 202 SSE job only when the
  capability provides native creation.
- `POST /api/agents/:name/backups/restore` returns a 202 SSE job only when the
  capability provides native restore/import.
- `GET /api/agents/:name/backups/download?file=` verifies manifest ownership.
- `GET /api/backups` applies normal user ownership filtering; admins see all.
- `POST /api/backups/:file/delete` removes the archive and manifest only after
  ownership/admin authorization.

## Goal 1 - OpenClaw Native Archive Backup

### Confirmed commands

Official OpenClaw CLI docs currently support:

```bash
openclaw backup create --output <directory> --verify --json
openclaw backup verify <archive> --json
```

The archive includes state, config, resolved credentials, channel/provider
credentials, auth profiles, sessions, and optionally discovered workspaces. It
ships its own `manifest.json`; Paddock must preserve it exactly.

### Paddock flow

1. Run `openclaw backup create --output /tmp/paddock-backups --verify --json`.
2. Parse the single JSON result to find the archive. Never guess its timestamped
   local-time filename.
3. Ensure the returned path is inside `/tmp/paddock-backups`.
4. Run `openclaw backup verify <archive> --json` if creation did not already
   report successful verification.
5. Copy unchanged to `/backup/<pad>_<native-name>` and write the manifest.

### Quirks and constraints

- The default archive name includes the local timezone and UTC offset, so the
  CLI JSON output, not filename parsing, is authoritative.
- Output paths inside state/workspace source trees are rejected to prevent
  self-inclusion. The temporary output must stay outside `~/.openclaw`.
- Existing archive paths are never overwritten. Each job needs a fresh
  temporary directory/name.
- `--verify` validates archive structure and OpenClaw-owned SQLite snapshots.
  It can be expensive for large workspaces.
- Workspaces are included by default. Provide a UI choice for full backup versus
  `--no-include-workspace`; show that `--only-config` is a separate narrow
  recovery artifact, not the normal PAD backup.
- If the config is invalid, workspace discovery makes full backup fail. The
  Console should offer the documented `--no-include-workspace` retry path.
- Rebuildable plugin/runtime roots and volatile session/log files are excluded
  by OpenClaw. Post-restore plugin dependencies may need
  `openclaw plugins update <id>` or reinstall.

### Restore status

Do **not** implement a full OpenClaw archive Restore button in this goal.
Current official docs document archive creation and verification, but no
full-archive `openclaw backup restore` command. They only document
`openclaw backup sqlite restore <snapshot-directory> --target <new-path>`,
which intentionally writes a new offline database and does not activate it.

The tab must say: **Native archive restore is not exposed by the current
OpenClaw CLI. Download the verified archive for operator recovery.**

Do not replace this restriction with `tar`, container bind-directory replacement,
or a made-up restore command.

## Goal 2 - Hermes Native Backup And Import

### Confirmed commands

Hermes v2026.4.13 introduced full configuration backup and restore through:

```bash
hermes backup -o <archive-path>
hermes import <archive-path>
```

`hermes backup -q` is the existing quick snapshot command in the Paddock driver,
but the Backup tab must use the full archive command for portable recovery.
`hermes import` is the native restore/import command.

### Paddock flow

1. Generate a container-side destination under `/tmp/paddock-backups/` and run
   `hermes backup -o <path>`.
2. Confirm the reported output exists at that path, copy it unchanged to
   `/backup/<pad>_<native-name>`, then write its Paddock manifest.
3. On restore, copy the selected owned archive into `/tmp/paddock-backups/` and
   run `hermes import <path>`.
4. Follow the current CLI's output and documented restart requirement. If it
   does not restart the gateway itself, restart the PAD after import and run
   the generic health check.

### Quirks and constraints

- The full archive protects Hermes configuration, sessions, skills, memory, and
  credentials. It contains secrets and must be stored in a protected backup
  root.
- Hermes also has project checkpoints and `/rollback`; they are not portable
  PAD backup files. Do not expose checkpoint rollback as the Backups tab.
- `hermes update --backup` creates update safety snapshots, not the explicit
  user-controlled backup artifact Paddock needs. Do not trigger an update just
  to make a backup.
- The older `hermes profile export/import` workflow is profile-scoped. Paddock
  should use the newer full `backup/import` workflow and validate actual CLI
  flags against the image version before shipping.
- Import changes live agent state. The confirmation must name the archive and
  warn that Paddock has no filesystem-level rollback.

## Goal 3 - OpenCode Session Export And Import

### Confirmed commands

Official OpenCode supports session portability only:

```bash
opencode export [sessionID]
opencode import <file>
```

The docs describe session exports as JSON; this is not an archive of OpenCode
configuration, auth, plugins, global state, or workspace files.

### Paddock outcome

Do not call this a PAD backup and do not put it in the shared Backups tab.
Implement later as a distinct **Sessions** action: export one selected session,
copy the JSON to `/backup/<pad>_<native-file>`, and offer import into that
same PAD if desired.

### Quirks and constraints

- `opencode export` without an ID is interactive, so Paddock must require a
  concrete session ID from the existing sessions API/UI.
- The export may include transcript and file data. The documented `--sanitize`
  option redacts sensitive transcript/file data; make the user choose normal or
  sanitized export before running it.
- Import accepts a local file or share URL, but Paddock must accept only the
  locally manifest-backed file. It must never proxy arbitrary URLs.
- OpenCode's built-in snapshots are in-session undo history, not portable
  backup/restore artifacts.

## Goal 4 - PicoClaw Unsupported State

The official PicoClaw CLI reference lists onboarding, auth, agent, gateway,
status, model, MCP, cron, skills, migration, and update commands. It does not
list a backup, export, restore, or import command.

### Paddock outcome

- Declare `backup.kind: 'none'`.
- Render an explicit Backups-tab empty state: **PicoClaw does not currently
  expose a native backup and restore CLI. Paddock will not archive its data
  folder as a substitute.**
- Do not use `picoclaw migrate`; it is an OpenClaw-to-PicoClaw migration tool,
  not PicoClaw backup or recovery.
- Recheck official PicoClaw docs and the pinned image's `picoclaw --help` when
  upgrading the driver. Add a native adapter only after both backup and restore
  commands are documented and live-tested.

## Goal 5 - Codex Unsupported State

Current official Codex CLI materials expose the coding CLI, configuration,
sessions/resume, and project workflows, but no native whole-profile backup,
export, import, or restore command.

### Paddock outcome

- Declare `backup.kind: 'none'`.
- Render: **Codex CLI does not currently expose a native PAD backup and restore
  command.**
- Do not treat workspace Git history, Codex session resume, or external backup
  tools as a Codex-native Paddock backup feature.
- Reassess after Codex releases a documented portable state export/import API.

## Files Expected To Change

- `docker-compose.yml` and deployment documentation - document the chosen host
  backup folder bind-mounted at the fixed `/backup` container path.
- `src/services/drivers/*.js` - replace `backupTypeMarker` with capabilities;
  OpenClaw archive-create-only, Hermes archive create/import, OpenCode session
  export/import, PicoClaw/Codex none.
- `src/services/backup-manager.js` - native command orchestration, sidecar
  manifests, safe native-file copying, list/download/delete; remove all generic
  `tar` and extraction behavior.
- `src/app.js` - SSE backup/import routes, authorization, global list, activity,
  and complete removal of the creation clone branch.
- `src/client/src/pages/AgentDetail.jsx` and new
  `src/client/src/pages/agent/BackupsTab.jsx` - capability-aware agent UI.
- `src/client/src/pages/GlobalBackups.jsx` - manifest list and source-PAD links;
  remove quick backup buttons and restore/clone shortcuts.
- `src/client/src/pages/CreateAgent.jsx` - remove every backup/clone field and
  restore progress path.
- `src/client/src/pages/agent/SessionsTab.jsx` or equivalent - separate future
  OpenCode session export/import UI, not part of this backup feature.
- `src/test/` and `docs/tabs/backups.md` - capability behavior, native commands,
  no-fallback guarantees, and backup-root setup.

## Tests

1. Verify an absent, missing, or read-only `/backup` mount refuses jobs before
   a driver command starts.
2. Verify no backup or restore path runs `tar`, extracts an archive, or changes
   a PAD bind-mounted data directory.
3. OpenClaw: create with `--verify --json`, resolve output from JSON, copy
   byte-for-byte under the prefixed name, list/download it, and show no restore
   action.
4. Hermes: full native backup, prefixed copy, native `hermes import`, required
   restart behavior, and post-import health check.
5. OpenCode: export a selected session ID and import its manifest-backed JSON;
   verify it does not appear as a PAD backup.
6. PicoClaw and Codex: unsupported state has no create/import endpoint or
   button.
7. Reject cross-PAD, cross-driver, missing-manifest, traversal-file, and
   unauthorized download/delete/import attempts.
8. Browser-test all capability states, SSE reconnect, Console error visibility,
   global list links, and Create PAD with no clone UI/request.
9. Build the SPA, restart the webui, run focused service tests, and live-test
   only with project-created test PADs.

## Sources Checked

- OpenClaw Backup CLI: https://docs.openclaw.ai/cli/backup
- Hermes official documentation: https://hermes-agent.nousresearch.com/docs/
- Hermes v2026.4.13 release notes (`hermes backup` / `hermes import`)
- OpenCode CLI: https://opencode.ai/docs/cli/
- OpenCode config/snapshot docs: https://opencode.ai/docs/config/
- PicoClaw official CLI/reference: https://docs.picoclaw.io/ and
  https://github.com/sipeed/picoclaw
- Codex CLI: https://github.com/openai/codex
