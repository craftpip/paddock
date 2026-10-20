# 94 — Runner and navigation plan groups

## Status: Complete (2026-10-19) — this index's organizational work (groups, order, dependencies) is done. Plan 91 is not a deliverable of this index; it continues independently under its own plan and queue item q-91, so its progress line stays unchecked here. Human decision: q-94 done.

## Group A — Infinite runner

| Order | Plan | Status | Outcome |
|---|---|---|---|
| 1 | [90 — Idle-only dispatch](archive/90-runner-duplicate-continuation-dispatch.md) | Complete | Stop repeated Continue prompts and resulting repeated `QUEUE.paused` checks during work; preserve legitimate pause checks |
| 2 | [91 — Prompt templates and reusable setup](91-runner-prompt-templates-and-idle-gating.md) | In progress | Editable `{{variable}}` prompts, preview/validation/persistence and a large reusable dialog/editor |
| 3 | [92 — Lifecycle callback scripts](92-runner-lifecycle-callback-scripts.md) | Complete | Paddock-stored system scripts for init, destroy, plan start/completion and usage exhaustion; durable events/results |

Plan 88 is the existing delivery-reconciliation prerequisite; recheck its current
implementation before plan 90. This grouping does not interrupt its active worker
or change its queue position. Plan 90 owns the scheduler fix; plan 91 consumes that
gate; plan 92 consumes stable lifecycle/attempt identity and reusable setup UI.

## Group B — App navigation

| Order | Plan | Status | Outcome |
|---|---|---|---|
| 4 | [93 — URL state and popup history](archive/93-url-app-state-and-popup-history.md) | Complete | Back/Forward, refresh and links restore selected sessions/views and open popups across the app, including runner editor sections |

Recommended overall order: **90 → 91 → 92 → 93**. URL codec/inventory work can begin
independently, but end-to-end runner popup integration follows the final setup UI.
If callback execution location remains undecided, leave that part blocked and work
on URL navigation without guessing the shell environment.

## Decisions and coordination

- Callback shell location is still undecided: Docker host or Paddock container.
- Plans 91–93 are queued in `QUEUE.md` in that order after existing entries; plan 90
  was already active. Existing item IDs/status/order are preserved. `infinite.md`
  is unchanged; this index is not a worker task.
- Keep existing plan filenames/links stable. Callback detail was extracted from 91
  into 92; URL/history is new in 93. Older runner plans remain their own records.
- Each executable plan tracks its own phases/tests/status. This index's statuses
  must follow the actual files when implementation begins; grouping is not completion.
- The user's documentation review hold still applies. Do not remove a completed
  plan until approved absorption into docs, following the existing plan lifecycle.

## Progress

- [x] Separate reliability, prompts/UI, callbacks and navigation responsibilities.
- [x] Preserve reported repeated-pause-file symptom and all five callback requirements.
- [x] Add URL/history requirements with read-only restoration and popup/draft handling.
- [x] Record recommended order and dependencies without changing queues.
- [x] Implement and verify plan 90.
- [ ] Implement and verify plan 91 — tracked by plan 91's own status and queue item q-91; not a deliverable of this index.
- [x] Implement and verify plan 92.
- [x] Implement and verify plan 93.
