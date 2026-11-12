# Runner Callback Scripts

An infinite runner can run optional shell scripts on five lifecycle events. This page covers the
events, where scripts are stored, how and where they run, how each event is deduplicated, and the
settings and history routes. The code is `src/services/runner-callbacks.js`; the settings surface
is `src/services/mission/runner-prompts.js`.

> Last updated: 2026-11-12

## Events

| Key | Recorded when | Deduplicated by |
|---|---|---|
| `init` | A 20-second callback tick sees the runner with `init` enabled | `runner:init` |
| `plan_started` | A queue item is observed entering `in progress` | runner, item, attempt |
| `plan_completed` | A queue item is observed reaching `done` | runner, item, attempt |
| `usage_exhausted` | Provider usage exhaustion is confirmed for the bound conversation | runner, episode |
| `destroy` | The runner is removed (`DELETE /api/mission/runners/:id`), or its project is deleted | `runner:destroy` |

The dedup key is a `UNIQUE` column on `runner_callback_outbox`, so concurrent ticks or a restart
cannot record an event twice. Pause, worker exit, session Close and webui shutdown fire nothing.
Deleting a whole project removes each of its runners first, through the same `removeRunner` as
a single Remove (`removeProjectRunners`), so each records its `destroy` while the project row
still exists to name it in the snapshot; only then are the sessions closed and the project row
deleted.

`init` runs at most once per runner. Saving never executes, and the create dialog saves callbacks
after the runner exists, so in practice `init` runs on the first tick after the script is enabled,
not at the instant of creation.

### Plan Events and Attempts

`observeCanonicalEvents` replays the canonical queue's mutation events (`runner_queue_events`) in
order, from a per-runner cursor (`runner_queue_event_cursors`). A worker that starts and finishes
a plan between two ticks still produces two events, so both callbacks fire. A runner seen for the
first time is baselined at its current state; past events are not replayed.

`runner_queue_observations` keeps one row per runner and item. `attempt` counts entries into
`in progress`:

- The first and each next item earn a new attempt and one `plan_started`.
- Resuming or restarting the same in-progress item is not a transition.
- An explicit requeue (`in progress` → `new` → `in progress`) earns a new attempt.
- A `done` with no observed start is recorded against attempt 1, with no invented start event.

Observation advances whether or not a callback is enabled, so enabling a script later cannot
replay old transitions. A completion is an observed queue transition, not proof the work is
correct.

### Usage Exhaustion Episodes

`observeUsage` receives tri-state evidence (`ok`, `exhausted`, `unknown`) from the worker's store,
or a definitive screen notice from `provider-limit.js` (see
[Backend services](services.md#opencode-free-quota-detection-provider-limitjs)). Store evidence
confirms exhaustion only when the busy probe positively answered "not busy", because a live turn
also ends in a user message. `runner_usage_state` holds the episode counter:

- Confirmed exhaustion while `clear` starts a new episode and records one event.
- `unknown` evidence changes nothing: it neither starts nor ends an episode.
- Only measured recovery (`ok`) returns the state to `clear`, so the next exhaustion is a new
  episode with a new dedup key.

A 429, silence or an empty reply alone is not exhaustion.

## Storage

Scripts are files at `src/data/runner-callbacks/<runner-id>/<event>.sh` (`RUNNER_CALLBACKS_DIR`
overrides the root for tests); the directory is git-ignored. Paths are built only from the
allowlisted event key and the server-minted runner id, so a caller cannot choose a file.

`runner_callbacks` (primary key runner and event) holds `enabled`, the SHA-256 `revision`,
`updated_at` and `recreate_resume`. Save writes the file (temporary file, then rename) before the
row, so a revision is active only once both are durable. A missing row or file reads as disabled.

| Rule | Code |
|---|---|
| Event key not one of the five | `callback_unknown_event` |
| Script is not a string | `callback_script_missing` |
| Enabled with an empty script | `callback_script_empty` |
| Script over 64 KiB | `callback_script_too_large` |
| `recreateResume` on any event but `usage_exhausted` | `callback_recovery_invalid` |

A disabled script keeps its text. `recreateResume` marks a `usage_exhausted` script as a quota
recovery script; its timeout is raised to at least 300 seconds.

## Execution

Scripts run inside the paddock control-plane container, not in a PAD and not on the Docker host.
The docker socket is mounted read-write so a script can act on containers; that is a host-root
equivalent privilege, which is why saving a script is admin-only (see
[Security Model](security.md)). Any command in the image is allowed (`curl`, `node`, `python3`,
`docker`, `sh`, `bash`).

1. Recording an event snapshots the script body and revision into the outbox row. Later edits,
   and the runner's deletion, cannot change a recorded event. An enabled event whose file is
   missing is recorded as an `error` row.
2. The pump claims a `pending` row atomically, writes the snapshot to a temporary file and runs
   `sh <file>`. Write scripts for POSIX `sh`; a bash shebang is ignored.
3. Execution is serial per runner and at most 4 scripts run fleet-wide. Launches never block
   supervision, Pause or settings; removal does not wait for a `destroy` script.
4. The timeout is 60 seconds and kills the whole process group. Each of stdout and stderr is kept
   up to 64 KiB, with truncation marked.
5. Status is `ok` (exit 0), `error` (non-zero or failed to start), `timeout` or `unknown`.

The environment is an allowlist; no Paddock credential is inherited. It carries `PATH`, `HOME`,
`LANG`, the non-secret routing settings `CONTAINER_PREFIX`, `WORKSPACE_ROOT`,
`HOST_WORKSPACE_ROOT`, `PUID` and `PGID`, and the event contract:

```text
PADDOCK_EVENT_ID  PADDOCK_EVENT  PADDOCK_EVENT_AT
PADDOCK_RUNNER_ID  PADDOCK_RUNNER_NAME  PADDOCK_PROJECT_ID  PADDOCK_PROJECT_NAME
PADDOCK_AGENT_NAME  PADDOCK_SESSION_ID  PADDOCK_ITEM_ID  PADDOCK_ITEM_ATTEMPT
PADDOCK_PLAN_PATH  PADDOCK_QUEUE_PATH  PADDOCK_USAGE_REASON
```

`PADDOCK_PLAN_PATH` and `PADDOCK_QUEUE_PATH` are the worker's paths and may not exist in the
control plane. The recorded working directory is the project folder, which is also a PAD path.
When it does not exist in the control plane, the script runs in the system temporary directory
and stderr starts with one `[paddock] working directory … does not exist in the control plane;
running in … instead` line.

A row caught `running` when the webui restarts is finalized `unknown` at boot and never re-run; a
script may have had side effects. `pending` rows launch normally after boot. An exit code never
marks a plan done, resumes supervision or bypasses a pause.

The 20-second callback tick in `app.js` runs the `init` baseline, queue observation, usage
observation and the pump, guarded separately from the runner watcher so a slow script cannot hold
up supervision.

## Routes and History

| Route | Purpose |
|---|---|
| `GET /api/mission/runners/:id/callbacks` | Five events (script, enabled, revision) and the catalogue |
| `PUT /api/mission/runners/:id/callbacks` | Save `{ event: { script, enabled, recreateResume } }`; admin only |
| `GET /api/mission/runners/:id/callbacks/history` | Settled executions for a live runner |
| `GET /api/mission/projects/:id/callbacks/history?runnerId=` | History after the runner is gone |

A save is partial: omitted events keep their settings. Every supplied event is validated before
any is written. The catalogue lists each event's meaning, the environment variables and the
limits; `GET /api/mission/projects/:id/prompts` serves the same catalogue to the create dialog.

`runner_callback_history` mirrors each settled outbox row (status, exit code, stdout, stderr,
truncation, working directory, timestamps). It stores plain-text runner and project identity with
no foreign key to `infinite_runners`, so the record, the outbox and the script files outlive the
runner. Output is whatever the owner's script printed and is shown as such. Script start and end
also appear in the runner's [history journal](../components/runner-history.md).

In the setup dialog the Callbacks section has one tab per event, an enable switch, a plain-text
shell editor (no template expansion), the event's meaning and variables, and the most recent run
with its exit code and output. Saving sends only the events that changed.

## See Also

- [Mission Queue and Runner](mission-queue.md)
- [Runner Prompt Templates](runner-prompts.md)
- [Runner History](../components/runner-history.md)
- [Security Model](security.md)
