# Health Tab

A per-PAD diagnostic toolbox that runs `openclaw` commands inside the container via `docker exec`. Accessible from the PAD detail page.

## Layout

Split into two sections:

**Toolbox** (top) — grouped command buttons:
- Diagnostics: Health, Status, Logs
- Doctor: Doctor, Doctor & Fix, Lint, Deep, SQLite Compact
- Security: Audit, deep audit, audit & fix
- Memory: Status, Reindex, Force Reindex, Promote
- Other: Backup, Update, Channels Probe

**Console** (bottom) — command output area with timestamped log display.

## UX

- Confirmation modal before dangerous or destructive commands.
- Commands that accept flags (--json, --verbose, --deep) let you toggle them.
- Danger commands (SQLite compact, force reindex) get a double confirm.
- Output is append-only per session. A "Clear" button wipes it.
- Running state indicator shows the current command in the console header.

## API

Commands stream via EventSource:

```
GET /api/agents/:name/exec-stream?cmd=<encoded-command>
```

Returns JSON lines: `{ type: "stdout"|"stderr"|"close"|"error", text: "..." }`.

## Components

File: `src/client/src/pages/AgentDetail.jsx` — `HealthTab` function (lines 181-289).
