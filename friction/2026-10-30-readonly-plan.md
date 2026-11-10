# 2026-10-30 — read-only harness inspection + plan write

- **Date:** 2026-10-30
- **Mode:** PAD MCP only (pad_mission_projects, pad_settings_get, pad_plan_list, pad_plan_write). Local read-only shell used only for the inspection the user asked for (`git status`, file listing) — not to work around a pad tool.
- **Task as phrased:** "Create a small project-local plan in plans/ capturing the inspection just completed … verify the plan appears via the plans facility and report the write/readback result."
- **Outcome:** Plan written and read back successfully. Two guessing-level findings.

## Findings

### `done` is null while `status` says done

- **Tool:** `pad_plan_write` + `pad_plan_list`
- **Severity:** guessing
- **What I asked:** write a plan whose header says `## Status: done`, then read the plan row back.
- **What happened:** the write result and the readback both contain `"status": "done", "statusRaw": "done", "done": null`.
- **Why it hurts:** the row carries two lifecycle signals that disagree. A caller keying on the machine-managed `done` field sees "not done" for a plan the `status` field calls done; only a caller who already knows the header is authoritative resolves it. Nothing in the result explains the precedence.
- **Fix:** stamp `done` when the `## Status:` header says done, or drop `done` from the row — one lifecycle field, not two.

### A plan write replaces silently and tells you nothing about it

- **Tool:** `pad_plan_write` + `pad_plan_list`
- **Severity:** guessing
- **What I asked:** create `plans/2026-10-30-readonly-harness-inspection.md` in project `test` (`/www2/paddock-test2`).
- **What happened:** the pre-write listing already held `read-only-test-harness-assessment.md`, created 26 s earlier by a concurrent session, covering the same scope. `pad_plan_write` accepted my distinct path, returned success with no revision/CAS and no indication whether it created or replaced a file; only my own read-before-write revealed the sibling. The project is `liveCount: 2`, so two callers were active on it.
- **Why it hurts:** had I reused the obvious slug I would have silently overwritten another session's plan and never known. The caller has to list first and invent a unique filename; the write result cannot be used afterwards to tell "created" from "replaced".
- **Fix:** return `created: true|false` (or `replacedExisting`) in the write result, and accept the current revision for CAS as `queue_write` does.
