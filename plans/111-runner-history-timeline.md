# 111 — Infinite runner history timeline

## Status: In progress (2026-10-19)

0/4 phases complete. Add a durable event timeline beside Queue in the existing
Mission runner panel, with a shared current-status strip and grouped recovery steps.

## User Flow

Open the existing infinite runner. Its header and current-status strip remain
visible. Queue and History tabs select the expanded panel's contents without
changing the selected session or remounting its terminal. Clicking a tab from the
collapsed panel opens it. History defaults to newest-first All activity, grouped
by local day; filters are Plans, Input, Recovery, and Problems. Recovery attempts
expand into recorded script, recreation, restoration, and receipt steps.

## Contracts

- Persist significant events when they happen, independently of callback enablement.
- Record requests, successes, failures, and unconfirmed outcomes distinctly.
- No fabricated old timeline: first observation is a dated baseline, not past work.
- No message bodies, answers, secrets, or full terminal dumps in the event journal.
- Group by recovery/callback id; use durable event keys to suppress poll duplicates.
- Scope reads through the existing runner permission gate; bounded, cursor-paged
  reads never scan the fleet or return another runner's events.
- Refresh without moving a user who is reading older entries; offer new-event count.
- Empty, loading, failed-read/retry, older-page, keyboard, and narrow-layout states
  must be visible and usable. URL remembers Queue/History.

## Implementation

- [ ] Add journal schema/service/API and lifecycle transition recording.
- [ ] Add History UI, filters, grouped details, pagination and refresh preservation.
- [ ] Verify meaningful service tests and actual browser interactions, including
  terminal identity, mobile layout, error/empty state, and reload persistence.
- [ ] Absorb verified behavior into docs and remove the completed plan.

## Files

`services/runner-history.js`, `services/db.js`, `services/mission.js`,
`services/runner-callbacks.js`, `services/quota-recovery.js`, `app.js`,
`client/src/components/QueuePanel.jsx`, new `RunnerHistory.jsx`, URL state helpers,
and focused test files. Use isolated databases and stub effects in lifecycle tests;
never rotate/recreate the user's PAD just to exercise timeline presentation.
