# 2026-10-08 — plan 69 P3 live pipeline proof

Driving the gated `task_*` / `task_pipeline_*` surface end to end over `/mcp`
while proving plan 69's server-side pipeline driver against a real Mission
session on `pad-opencode-proj`. The gate itself (`PADDOCK_TASK_QUEUE=1` in
`.env`, webui recreated) worked as designed: 46 registered tools, 31 visible,
15 `task_*` hidden when the flag is off again.

### A session created without write access to opencode's state dir has NO MCP tools — and the absence sticks to that conversation

- **Tool:** `task_pipeline_start` + `mission_session_start` (the pipeline's
  whole self-report contract)
- **Severity:** blocker
- **What I asked:** let the bound agent answer its own step prompts with
  `task_step_report`.
- **What happened:** the first session reported
  `Tools containing 'pad': NONE … No MCP-origin tool of any name is registered
  in this session`, so the review prompt had nothing to answer with and the
  task parked at `timeout` after 600967ms. Root cause: at session creation
  `/root/.local/state/opencode` was `root:root 755` while the TUI runs as uid
  1000, so `opencode mcp list` died with
  `PermissionDenied: FileSystem.makeDirectory (…/locks/…)` and MCP never
  loaded. **After `chown -R 1000:1000 /root/.local/state` the absence
  persisted for that conversation**: a *fresh* headless
  `opencode run "…names of tools containing pad…"` listed all 46 (including
  `pad_task_pipeline_*`), the same command with `-s <the old session id>`
  answered `NONE`, and relaunching the TUI (`mission_session_relaunch`) did
  not help either. A session started after the chown had every tool.
- **Why it hurts:** from the tool surface both states look identical — a live
  session, a delivered prompt, and then silence until a park 10 minutes later.
  Nothing in `mission_sessions` / `mission_send` says "this conversation has
  no tools", so the caller can only conclude the model is ignoring the prompt.
- **Fix:** cheapest is an explicit refusal at the point that matters — when
  `mission_session_start` / `mission_session_relaunch` mints a session, verify
  the pad can list MCP (`opencode mcp list` as the TUI's uid) and fail loudly
  if not, instead of handing back `live: true`. Second half: something on the
  opencode side must stop a toolset-less session from being sticky, because
  `-s <id>` reproducing `NONE` after the cause is fixed is what turns a one-off
  permissions bug into a permanent dead conversation.
- **Resolution (2026-10-11):** root cause re-verified live and **fixed**. The
  node TUI and a root `opencode web` process share `/root/.local/state/opencode`
  (uid 1000 has `HOME=/root`), and the root side owned `locks/`, so the node
  side's MCP registration died with the identical error:
  `PermissionDenied: FileSystem.makeDirectory (…/locks/…lock)`. `sudo chown -R
  1000:1000 /root/.local/state/opencode` applied and verified: `opencode mcp
  list` now reports `browser` / `paddock` / `pad` connected. The caller-side
  rule survives unchanged: a *running* conversation with zero tools keeps zero
  tools — restart the session to pick them up.

### The friction log itself is not writable by the agents who file into it

- **Tool:** (not a tool — filesystem)
- **Severity:** blocker
- **What I asked:** the bound agent, mid-pipeline, to record what it hit.
- **What happened:** `Permission denied` writing
  `/www2/paddock/friction/…` — the folder is `root:root drwxr-xr-x` while the
  TUI runs as uid 1000, and the pad has `/www2` mounted rw but nobody to own
  the files.
- **Why it hurts:** findings are discovered by the session that cannot write
  them, so they reach this log only when a root-side caller notices and types
  them up — exactly the ones most likely to be missed.
- **Fix:** give `friction/` (and any other root-side collection dir an agent
  is asked to append to) the `PUID:PGID` ownership the rest of the tree gets,
  or have the webui append on the agent's behalf through `workspace_write`.
- **Resolution (2026-10-11):** **fixed and verified.** `sudo chown -R 1000:1000
  /www2/paddock/friction` applied; the uid-1000 TUI now passes a touch probe in
  that directory. The standing point stands: root-side collection dirs an agent
  is asked to append to need the same PUID:PGID ownership the rest of the tree
  gets.

### `pad_workspace_write` refuses where `pad_exec` writes fine, and does not say so

- **Tool:** `pad_workspace_write` → fell back to `pad_exec`
- **Severity:** guessing
- **What I asked:** the review step wrote `PIPELINE-PROOF.md` into the
  session folder.
- **What happened:** `pad_workspace_write` refused with `host file browser
  unavailable for this PAD` (its host-browse capability is off for
  `pad-opencode-proj`); the agent fell back to `pad_exec` and `cat`-ing the
  file in, which worked.
- **Why it hurts:** the refusal names a capability but not the equivalent
  path that works, so every caller has to discover the fallback itself — the
  tool looks like "this pad cannot write files at all".
- **Fix:** one sentence on the refusal: *write with `exec` (e.g. a shell
  redirection) when `hostBrowsable` is off* — the capability and the
  alternative belong in the same message.
