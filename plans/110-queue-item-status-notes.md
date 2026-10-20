# 110 — Mission queue item status notes

## Status: Proposed — 2026-10-20

0/3 phases complete. The Mission page's queue becomes invalid when a completed
item's `reason` carries the LLM's completion note, even though the note is useful
to the human and does not affect queue scheduling.

## Requested Outcome

A queue item's required `reason` field can carry an optional human-readable note
at every status. `need input` remains the one status that requires a non-blank
reason, because it is the actionable blocker the runner must present and wait on.

The queue shown in the report must accept an item such as:

```json
{
  "id": "q-53-mission-workspace-20261018",
  "plan": "53-mission-workspace.md",
  "status": "done",
  "reason": "Completed after the Mission workspace fix was verified."
}
```

Mission's `QueuePanel` must not report `Queue is invalid` solely because a `new`,
`in progress`, or `done` item includes a note. The note is informational; it must
not make an item block the queue, alter aggregate state, or change the next-item
selection.

## Contract And Scope

- Keep `reason` required and typed as a string for every queue item. Do not add a
  second `note` field or make the JSON shape permissive.
- Keep the fail-closed `need input` rule: its reason, after trimming whitespace,
  must be nonempty. The existing readable `queue_item_invalid` refusal remains
  appropriate for an empty blocker explanation.
- Allow empty or nonempty string reasons for `new`, `in progress`, and `done`.
  Preserve their exact text through parse, queue projection, revision-protected
  writes, reads, REST responses, and MCP queue writes.
- Do not use a non-blocked item's note as `queueAggregateState(...).reason` or as
  the queue's `blocked` item. Queue state continues to depend only on statuses.
- Update the queue template rule in `src/services/plans.js` and the
  `pad_queue_write` schema/description in `src/mcp.js`: `reason` is required for
  every item, mandatory and nonempty for `need input`, and optional context for
  every other status. Remove wording that tells agents to clear a useful note.
- Audit only queue-specific guidance. Worker prompts still need to instruct an
  agent to put the exact unresolved question in a `need input` reason; this change
  must not weaken the stop-and-wait rule.
- Trace the Mission read path through `src/services/mission.js` and
  `src/client/src/components/QueuePanel.jsx`. The page must keep rendering the
  server's valid queue summary; this is a parser-contract repair, not a client-side
  exception that suppresses an invalid response.

## Implementation Steps

1. Trace `parseQueue()` and `validateQueueItems()` in `src/services/plans.js` and
   make their status/reason predicate identical: reject a missing/non-string
   reason and an empty trimmed `need input` reason, but remove the non-`need input`
   empty-string restriction.
2. Update the generated `QUEUE.md` editing rule and `pad_queue_write` MCP schema
   text so an LLM receives the same contract from every write surface. Keep the
   schema's string requirement and the status enum unchanged.
3. Update `src/test/queue.test.js` with direct parser coverage and a real
   `writeQueue()` then `readQueue()` round trip containing notes on `done`, `new`,
   and `in progress`. Retain the empty-`need input` refusal test as the control.
   Add or adjust focused MCP schema/description coverage if an existing MCP test
   pins the queue-write wording.
4. Add focused Mission queue coverage if the current Mission queue tests do not
   already prove that a valid `done` note reaches `QueuePanel` as `done` rather
   than the invalid banner.

## Verification

- Run `timeout 60 docker exec paddock node --test test/queue.test.js` and the
  focused MCP suite that covers `pad_queue_write`, individually.
- Verify the regression shape through the actual queue read/write surface: write
  a `done` item with a completion note, read it back unchanged, and confirm the
  aggregate is `done`, not `invalid`.
- Verify a whitespace-only `need input` reason still refuses with
  `queue_item_invalid`; verify a nonempty `need input` reason remains the sole
  blocker returned by the queue summary.
- Restart the webui and inspect the affected Mission queue in
  `http://10.69.1.164:6789/mission`. Confirm it renders as completed rather than
  invalid, its note remains visible where queue item context is displayed, and no
  console or request failures occur.
- Update the queue contract documentation when the code lands, then absorb this
  plan into the matching `docs/` reference before deleting it.

## Progress

- [ ] Permit status notes without weakening the `need input` blocker requirement.
- [ ] Align template and MCP guidance with the accepted queue shape.
- [ ] Add parser/write and Mission queue regression tests, then verify end to end.
