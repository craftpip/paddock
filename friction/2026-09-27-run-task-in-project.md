# Chat Test — "Give a task a check of my IP", in the craftpip project

**Date:** 2026-09-27
**Mode:** chat test (MCP tools), with two documented deviations: I used
`exec` against the pad and the pad's own opencode HTTP API after the tool
surface stopped being able to tell me whether the work was done. Both
deviations are recorded below as findings.
**Task:** "give a task and check out my IP", then "use the craftpip project" →
run a read-only IP report as agent work in the craftpip project.

Outcome: the work got done twice, and neither route reported it cleanly. The
task queue cannot address a project at all and then ran in a folder that does
not exist; the Mission route ran in the right folder but lost the prompt once
and never displayed the answer. The answer I am reporting came from the pad's
HTTP API, not from the tool surface.

## Findings

### `task_submit` cannot target a project — "in craftpip" is not expressible

- **Tool:** `task_submit` + `mission_projects`
- **Severity:** blocker
- **What I asked:** run the IP check in the craftpip project.
- **What happened:** `task_submit` takes `name` — a PAD. Projects belong to the
  other half of the surface: `mission_projects` returns `prj_63b9d46aa0de6928`
  (name `craftpip`, folder `/www1/craftpip.com`, `agent: "pad-opencode-proj"`).
  No `task_submit` field accepts a project id or a folder. The nearest handle is
  the project's `agent` field, so I submitted to `pad-opencode-proj` — but
  nothing in either tool's description says a project's `agent` is the handle to
  use, or that the two families are connected at all. The run also happened in
  the PAD's workspace, not `/www1/craftpip.com`, so even the inferred mapping
  does not put the task in the project's folder.
- **Why it hurts:** the surface has two names for the same place — PAD and
  project — and no shared id. A caller asked to work "in a project" either drops
  the constraint without noticing or has to reverse-engineer `project.agent`.
  I picked the PAD by guessing, and had to be told off for it.
- **Fix:** accept `project_id` (or `folder`) on `task_submit` and use it as the
  cwd; failing that, state in the description that a task always runs in the
  PAD's workspace and that a project is reached through its `agent`.

### `task_submit` runs in the driver-default folder, which the pad does not have

- **Tool:** `task_submit` + `task_result` + `settings_get`
- **Severity:** blocker
- **What I asked:** report the machine's IP addresses (read-only).
- **What happened:** on `pad-opencode-user1` the task failed in 2s. `task_status`
  gave `status: "error", exit_code: 1` with an empty stdout tail and no summary;
  only `task_result`'s stderr carried the cause:
  `Error: Failed to change directory to /root/.opencode/workspace`. That pad's
  `settings_get` says `workspaceMount: {host: "/www2/user1", container:
  "/www2/user1"}`. `/root/.opencode/workspace` is the opencode driver's default
  workspace and does not exist in that container. The same submit on
  `pad-opencode-proj` worked, because that container happens to have the default
  folder.
- **Why it hurts:** the caller cannot pass a cwd, and the only clue is a raw
  stderr string naming a path the caller never mentioned and cannot act on. The
  correct folder is not a secret — the client already publishes it as
  `workspace_dir` on the agent list, "custom mount when set, else the driver
  default" — so the task path is reading a different, wrong source.
- **Fix:** resolve the cwd the way the agent list does, and when it is missing
  refuse with a `task_workspace_missing` code naming the mount that was meant,
  the way `mission_session_start` refuses with `mission_folder_missing`.

### `mission_send` returns `ok: true` for text the TUI never received

- **Tool:** `mission_session_start` + `mission_send`
- **Severity:** blocker
- **What I asked:** send the IP prompt into a new session in craftpip.
- **What happened:** `mission_session_start` returned
  `state: {live: true, tuiAlive: true, command: "opencode", cwd:
  "/www1/craftpip.com"}`. I sent 3s later. `mission_send` returned
  `ok: true, sent: {lines: 1}`. The next read showed the composer still empty —
  at the `Ask anything…` placeholder, with my prompt nowhere on the pane. No
  error, no warning. The identical text re-sent ~45s later was delivered and ran.
  `tuiAlive: true` at start means the process is up, not that the composer is
  accepting input.
- **Why it hurts:** the send path types into a TUI that may still be painting its
  first frame, and its only success signal is indistinguishable from a
  delivered keystroke. A caller that sends once and polls sees an agent that
  ignored the prompt, and either re-sends — duplicating work inside a live
  conversation — or gives up. The window is small and it sits exactly where a
  caller is most likely to fire, because start and send belong to the same
  request.
- **Fix:** `mission_send` should confirm the pane took the text (compare pane
  content across the write) and either retry briefly or return
  `mission_tui_not_ready` — never a bare `ok: true` for a keystroke that went
  nowhere.

### A finished turn leaves no trace in the pane, so a completed session reads as a stall

- **Tool:** `mission_sessions`
- **Severity:** blocker
- **What I asked:** read the answer back out of the session I had just sent work
  to.
- **What happened:** ~90s after the send, `mission_sessions {session_id}` returned
  `busy: false, busyKnown: true, open: false` and a screen tail containing my
  prompt and the tool call `$ hostname -I; …` with its output — and no assistant
  text. Byte-identical screen at 30s, 90s, 150s and 240s.
  `exec {command: "tmux capture-pane -p -t msn-f044ab74"}` returned the same, so
  the missing text is in the pane, not in the tool's capture. The opencode server
  on the pad's own port disagreed completely: `/session/status?directory=
  /www1/craftpip.com` → `{}` (idle) and `/session/ses_f1dddfa03ffezh56F2CkYVkfeA/
  message` → a finished assistant message with a full markdown table and 400
  output tokens. The session list had even auto-titled it "Machine IP addresses
  and default route".
- **Why it hurts:** the screen tail is the only channel the surface offers for
  reading a session, and "not busy, no answer on screen" is indistinguishable
  from "the agent stopped mid-turn" or "the prompt never arrived" — all three of
  which happened in this one session. A caller cannot tell done from stuck, so it
  re-sends, or leaves the answer behind: I had to go around the MCP surface to
  the pad's HTTP API, and the answer I gave the user came from there.
- **Fix:** force a pane repaint before capturing after a send (the TUI likely
  needs one once a burst of pasted text lands), and stamp the row with the
  agent's own completion state so a caller can distinguish finished from stalled
  without reading pixels.

### A webui restart voids a running task, and `error` + `result: ""` hides work that succeeded

- **Tool:** `task_submit` + `task_status` + `task_result`
- **Severity:** guessing
- **What I asked:** report the machine's IP addresses.
- **What happened:** the task on `pad-opencode-proj` ran correctly and was nearly
  finished when it stopped. `task_status` → `status: "error", exit_code: null,
  result_summary: ""`. `task_result` → `result: "orphaned by webui restart"`, with
  every command and its output sitting in `stdout` as unparsed NDJSON
  (`step_start` / `tool_use` / `step_finish` records, plus the agent's own
  `result_summary` mid-thought: "`ip` isn't installed. Let me use read-only
  fallbacks."). Four `VM WebUI listening on port` lines appeared in the last 15
  minutes, so the webui restarted repeatedly during the session; `RestartCount`
  was 0 and there was no stack trace, so nothing crashed — something started the
  container externally.
- **Why it hurts:** `error` with a null exit code and an empty `result` reads as
  "the task failed and produced nothing", which is false — the tool hands back
  the whole answer in `stdout` and simply does not interpret it. A caller that
  trusts `result` concludes the pad or the model is broken. Nothing in
  `task_submit`'s description warns that a webui restart kills in-flight tasks,
  even though the sibling job tools are documented as in-memory and restart-lost.
- **Fix:** give the orphan its own state (`orphaned`) rather than folding it into
  `error`, note the restart dependency in the description, and parse the last
  assistant text out of the NDJSON so `result` is populated even for a run that
  was cut short.

## See Also

- [`docs/tabs/mcp.md`](../docs/tabs/mcp.md) — the tool reference these findings
  contradict.
