# 109 — Quota recovery callback, recreate, and resume

## Status: In progress (2026-10-19)

3/4 phases complete. The user supplied `/www1/test/log-arguments.sh --rotate testing`
as the reference command. It logs arguments only; it does not restore provider quota.

## Contract

An explicitly opted-in usage-exhausted callback runs in the control plane, outside
the PAD. The user script invokes the supplied command and controls recreation with
`paddock pad recreate "$PADDOCK_AGENT_NAME"`; no internal Node calls are required.
The UI setting is `Resume queue after recovery script succeeds`; Paddock does not
recreate the PAD a second time after the script has done so.
Exit 0 authorizes restoration of the saved Mission conversation and one queue
continuation; exit 75 holds; all failures/timeouts hold with an explanation.
Ordinary notification callbacks cannot authorize resume. Persist ownership before
launch and before continuation. Pause/Close or a changed session/generation wins.
An interrupted recovery is never blindly replayed. The script is once per quota
episode; the test command cannot be treated as proof quota has actually reset.

## Work

- [x] Implement durable opt-in recovery context and script-result handling.
- [x] Restore the same conversation after recreation, with a single continuation.
- [x] Test success, hold, failure, duplicates, and superseded recovery.
- [ ] Configure reference wrapper and verify log, recreation, session identity, and queue outcome live.

## Verification So Far

Explicit Run while stopped for quota now requests a deliberate recovery retry
(deduplicated against an in-flight callback/recovery). Automatic observer polls
remain once per exhaustion episode. The first Run test exposed that adopting the
quota-retrying worker only toggled Running back to Need input with no callback;
that path now queues recovery instead of pretending progress resumed.

The first live attempt logged `--rotate testing`, recreated the PAD and its door,
and preserved the conversation, but continuation was unconfirmed. This exposed
input arriving before the TUI mounted. Recovery now waits for the interactive
footer, pastes atomically, and requires an exact persisted input receipt before
enabling dispatch.

Live test on 2026-10-19: explicit Run wrote
`[2026-10-19T17:32:28Z] --rotate testing` to `/www1/test/arguments.log`.
Callback `cb_35fb0e53bfdcf594` exited 0, recreated the PAD/door, and restored
`msn_8e6e804094a6b215` / `ses_eaeb2cf1fffe6977DJWwiNgmh6`.
Its exact continuation receipt is `msg_1553919f1001Dn1wkk02MwrbUC`.
OpenCode appends a trailing space after paste; canonical matching and late receipt
reconciliation fixed that false unconfirmed outcome without another send.
Recovery settled as `exhausted_again`, not an error: the reference script logs but
does not restore real quota. The UI states `Recovery continuation accepted, but
provider quota is still exhausted`. Healthy provider recovery remains unverified.

The live callback environment also exposed an omitted deployment prefix. Its
allowlist now includes only the non-secret workspace/prefix/ownership settings
the CLI needs. No general environment or credentials are inherited.

The saved callback has been replaced through the UI with the plain command plus
`paddock pad recreate "$PADDOCK_AGENT_NAME"`. Reopening the dialog confirms the
script, enabled flag, and resume preference persist. CLI tests pass 6/6, callback
tests 42/42, runner tests 37/37, and tmux tests 25/25. Production SPA build passes.
