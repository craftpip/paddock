# Plan 52 — Orchestrator (session-based: keys, grants, conferral, playbook, proof)

## Status: Rewritten (2026-10-06) — **5/7 phases complete (A, C, D, E; B2 done);
B1's 5/7 clauses done and its two journal clauses still wait on 53 Phase 9; F
deferred; G open (user-gated).** A1 audited + fail-closed default; **A2 DECIDED and DONE (2026-10-06)** — after the user's call, `exec` flipped from a base grant to an opt-in `tools:exec` bucket, so the least-privilege key of D2 is now expressible (mission_send/start/close/relaunch/restart and the task_* run verbs all ride it; `workspace_write` stays base); A3 `autoApprove` flipped to opt-in (R3 closed). Phase A gate: all suites green (mcp 139, task-mcp 28, plan-mcp 42), mutation control proved (re-adding `exec` to the base branch turns exactly the 3 opt-in pin tests red), webui restarted, tool surface verified live at 31 tools. **R8 DECIDED (a) and DONE (2026-10-06): implemented as decided.** The user chose "newest tool part is `running`" — a session is busy iff its own newest tool part's `state.status === 'running'`, read from the conversation's own store (`mission.busyForSessions`, one `agentStore.readActivity` per session id, cached ~5s). This replaces the per-(PAD, folder) `GET /session/status` web probe (retired), which only ever reported conversations the web process itself drove and reported nothing during a Mission pane's turn. `busy` still requires `live`; a dead row answers `busy: false` and carries `wasBusy: true` while its store says a tool part is running. Verified: mission 118/118, mcp 139/139, task-mcp 28/28, plan-mcp 42/42, mutation control (stored copy, `=== 'running'` → `=== 'completed'` in `busyForSessions`) turns exactly the 3 store-backed pins red while the rest stay green. Live: a dead row whose conversation's store reports `running` answers `busy:false, busyKnown:true, wasBusy:true, state:dead` — the pinned contract. **B1 done 5/7** (the two missing clauses name tools plan 53 Phase 9 has not built); **B2 decided 2026-10-06** — `pad_help`'s `GENERAL_GUIDE` IS the onboarding artifact, so B2 becomes an onboarding-completeness audit of it (not a new file); **B2 audit COMPLETE (2026-10-07), 4 gaps fixed in the guide** — `mission_permission_answer` was never named, three error codes were missing (`mission_permission_pending` / `mission_not_an_agent` / `mission_tui_already_running`), the `canSend` verdict was absent, and a `recreate`'s cost to live sessions was unwarned; mcp 140/140. **C1's path is proven live twice** and surfaced C1-F1 which became R7+R8; **R7's id half is fixed and proven live** (fresh start mints its own conversation, `stampTruth` fails closed). **E1 complete and proven live** — the audit log's `actor` column is never empty (702 rows read `system` before; seven Mission actions now attributed). **Phase D COMPLETE (2026-10-07), committed e2ec24d** — conferral (orchestrator MCP key `default` + driver wiring + Remove), Profile key presets, and the server-side namespace split, all pinned by the new `orchestrator.test.js` (7) + mcp D3 (140) and verified live end to end on a throwaway opencode pad (confer → `paddock connected` → remove, no residue). Live finding that earned its own rule: `execFile`+`input` HANGS the container's docker CLI at `read`, so `execInPad` is spawn with a 60s kill-to-fail guard — a hung wire is now a rollback, never an orphaned full-reach key. **Phase C COMPLETE (2026-10-07): C1 green twice on two projects** (paddock, test) — the second run proven live against a real answer; the "two models" clause filed as a gap (fleet has only opencode pads). **Phase E COMPLETE (2026-10-07): E1** audit attribution; **E2** minimum spend visibility (col-1 `N live · M sessions`, browser-verified); **E3** dead-session recovery proven (restart → same tmux + conversation, transcript intact); **E4** resume-cost proven (same store row continues; a resumed turn answered history with 0 tool calls vs the original's `read`). remaining: B's two journal clauses (53 Phase 9), F (LATER), G closings (user-gated). The queue is empty;
this plan now orchestrates **sessions**, not tasks. User decision, verbatim:
*"don't let the user start any task without my vision — remove task submit"*,
followed by *"rewrite 52 around mission_* sessions"*. **Everything below is
rebuilt on that basis**; the pre-2026-09-27 task-queue design is superseded and
kept only as the retired→replacement map in §3 so nothing is silently lost.

**Division of labour with plan 53 (no overlap, no two-builds):**

| Owns | Where |
|---|---|
| The Mission page, the two tables, `mission.js`, the 5 `mission_*` MCP tools, memory/journal | **plan 53** |
| API keys, tool-grant buckets, per-PAD scoping, revocation, the orchestrator role, the playbook, the proofs, the risk register | **this plan** |

The surface the user works in is 53's page. This plan owns *who may do what*.

---

## 1. The model (what changed, in one paragraph)

A unit of work is a **session**: a live agent TUI inside a PAD, in a folder,
that the human and the agent both watch and both type into. A **project** is
`(agent, folder)` — many per agent. The agent's whole loop is the same four
steps the human does in the browser (53 §1a): *agent exists → project exists →
session is open → work happens in the session.* There is no fifth step, and in
particular **no headless run**: nothing the agent does happens where the user
cannot see it. The tools that let the agent walk that path are `mission_*`; the
tools that let it manage machines remain `pad_*`.

## 2. The agent's tool surface

- **Work (53 Phase 7):** `mission_projects` (read) · `mission_sessions` (read,
  incl. the live screen tail) · `mission_project_create` (`create`) ·
  `mission_session_start` (`exec`) · `mission_send` (`exec`, refuses on a
  solo-locked session).
- **Machines (exists today):** `pad_create_agent` / `pad_start_agent` /
  `pad_stop_agent` / `pad_restart_agent` / `pad_update` / `pad_recreate` /
  `pad_delete_agent` / `pad_health` / `pad_settings_get` / `pad_exec` /
  `pad_config_get` / `pad_workspace_*`.
- **Context (53 Phase 8):** per-project notes + an **ordered checklist** — the
  LLM appends "do A, then B, then C" as items and works them one at a time in a
  visible session, ticking each off. No server-side runner: the checklist is
  "what's left" across a closed chat, not a background worker (option A, user
  2026-09-27).
- **Not used by the agent:** the whole `task_*` family. Retired — see §3.

Grant buckets are unchanged: `read` (the two list/read tools), `create`
(`mission_project_create`, same bucket as `create_agent`), `exec`
(`mission_session_start`, `mission_send`, same bucket as the old exec verbs).

## 3. Retired → replacement map (traceability for the old design)

| Retired (task queue) | Replacement | Note |
|---|---|---|
| `task_submit` (start headless work) | `mission_session_start` | Same intent, visible: the user watches it happen |
| `task_get_next` / `task_complete` (worker pull) | *none needed* | The agent is told what to do; it does not go looking for work |
| `task_watch` / `task_status` / `task_result` | `mission_sessions` (+ screen tail) | Better: you see the work, not just its stdout |
| `task_steer` | `mission_send` | Types into the live session; no resubmit-with-tail waste |
| `task_approve` / `task_cancel` | *none* | Approval was the cost of invisible work; visible work needs neither |
| `task_priority`, `task_list` | *none* | No queue to order or list |
| Steering races (R7, R8), submit idempotency (R10), self-reported "done" (R12), stuck-task alerting (R14) | **retired with the queue** | No submit → no double-dispatch; no steering column → no steer race; no done-state → nothing to self-report; no poller → a session is visibly live or visibly dead |
| Task/journal memory keyed on `task_id` | notes/journal keyed on `project_id` | Same idea, stable anchor (53 Phase 8) |
| `tasks` table + runner | left in the tree, **unused** | Deleting the module is a separate cleanup decision, not an orchestration one |

## 4. Governing laws (amended 2026-09-27; unchanged where not noted)

1. Lifecycle: the front door stays up; everything else scales to zero. Stop
   remains user-relayed for explicit stop orders; idle-stop is automatic
   housekeeping; delete is human-confirmed, always.
2. One holder, no layer-skipping: only the orchestrator PAD (role conferred by
   fleet-MCP wiring, [51§1b]) holds the `exec` bucket that can open and type
   into sessions. Outside LLMs get orchestrator-verbs only. *(Unchanged in
   spirit — `mission_session_start`/`mission_send` are `exec`, so law 2 now
   governs them too. This is the single most important consequence of the
   rewrite: **whoever holds `exec` can drive any unlocked session on a PAD it
   owns**, which is why Phase A's grant scoping and Phase E's audit log are not
   optional.)*
3. ~~Token ladder~~ → **Amended: spend nothing invisible.** Resume/continue a
   session (`opencode -c`, `codex resume --last`, `claude -c`) before opening a
   new one; never re-send a prompt into a session that already has the answer.
   Early-stop on a stale session is a user action, not an automatic kill.
4. Additive-only on existing paths; lifecycle laws outrank any request,
   including the user's own chat messages.
5. Done = proven: unit tests green, restart, live-verify (throwaway PAD +
   browser where UI touches) before any item counts. Docs absorb per plan, each
   gated on explicit user confirmation.
6. **New: nothing runs where the user cannot see it.** No headless work path
   from the agent, ever. If a future feature seems to need one, it needs the
   user's explicit sign-off, not a clever workaround.

## 5. Modes: orchestrator optional, direct by default (user requirement)

- **Direct mode (DEFAULT, zero setup).** The user's LLM holds a key with the
  `read`/`create`/`exec` buckets and drives sessions itself. Setup = copy the
  key. This is the day-one experience and it never goes away.
- **Orchestrator mode (one-click upgrade).** One PAD is conferred the fleet MCP
  with the orchestrator grant and becomes the orchestrator; outside LLMs drop to
  orchestrator-verbs. For long runs, multi-client (phone/Telegram) or
  multi-model work.
- Downgrade is symmetric: unwire → back to direct, notes/journal stay in the DB.
  No mode traps the user.

## 6. Frontend reality check (user, 2026-09-24; updated 2026-09-27)

No new screens **in this plan**. The one named exception is 53's Mission page —
the orchestration workplace — and 53 builds it. This plan adds no UI of its own
beyond what rides existing surfaces:

- Direct mode needs no UI beyond the key copy that exists today.
- Orchestrator mode = ONE button on agent detail ("Make orchestrator" /
  "Remove") + ONE status chip in the agent list. Both ride existing surfaces.
- Grants, namespaces, folder assignment: files/keys under the hood, editable
  where configs are already edited. If something needs a new screen, redesign
  the requirement, not the frontend.

---

## Phase A — Keys, grants, namespaces (FIRST)

The gate for everything: the agent can only do what its key says.

- [x] A1. Grant model audit + complete (**done 2026-09-29**). The audit found the
      map **complete** — 31/31 tools on the default surface, 40/40 with
      `PADDOCK_TASK_QUEUE=1`, no orphan buckets, and every bucket name one a key
      can actually hold — so the gap this item predicted had been closed by hand.
      What was still wrong is the **default**: `if (!grant) return
      targetAllowed(...)` made an unclassified tool **allowed** for every
      fine-grained key, so the next tool registered without a map entry would ship
      ungated exactly as `task_steer` did, and a diff of that tool's
      registration would never show it. It now fails **closed**. Two tests: one
      pins the default on a name that is by construction in neither set, the other
      enumerates the real registration **by registering against a fake server**
      rather than parsing names out of the source — the source contains 9
      `task_*` tools behind an env gate that are not on the surface at all, so a
      source count says 40 when the surface is 31. Also pinned there: the three
      task READERS stay in the read bucket (giving them a map entry would hand a
      read-only key the ability to run work) and the six mutators are `exec`.
      Per-PAD scoping (`target:agent:*`) and revocation were already enforced by
      `requireTool` and are covered by existing tests. Mutation controls:
      restoring the fail-open default turns **1** test red; dropping
      `task_cancel`'s map entry turns **2** red. mcp 136/136, task-mcp 28/28,
      plan-mcp 42/42, mission 97/97, auth 3/3.
- [x] A2. Mission grants **DECIDED + IMPLEMENTED (2026-10-06).** The item asked
      for a fail-closed proof that "a key without `exec` gets `Not permitted by
      API key tool grant: mission_send`". Writing it showed there is no such
      key: **`exec` was a BASE grant** (`toolAllowed` returned early for
      `READ_TOOLS`, `exec`, `workspace_write`, and anything the map routes to
      `exec`), so every fine-grained key held it and the least-privilege key D2
      describes could not be expressed. The user's call (infinite.md § Needs
      your call, "make exec an opt-in grant") was ASKED and ANSWERED. Now:
      **`exec`, `mission_send`, `mission_session_start`, `mission_session_close`,
      `mission_session_relaunch`, `mission_session_restart`, `mission_permission_answer`,
      `plan_write` and the task_* mutators all require the `tools:exec` bucket** —
      a brand-new key starts with read + `workspace_write` + its `target:` scope
      and nothing that runs work or types into a session. No live key is
      affected (all are `control`/`default`, which return before the map is
      read). Pin: the "PINS exec as an OPT-IN grant" test asserts the
      fail-closed matrix (no `tools:` grant → all three session verbs refused;
      `tools:exec` → all three granted). Controls: re-adding `exec` to the base
      branch turns exactly the 3 opt-in pins red (exec opt-in, base
      fine-grained, task exec bucket) while the other 136 stay green. `git log`
      note: this is one of two 2026-10-06 decisions that unblock plan 52 from
      R8's cost question (the other is the busy semantics choice, below).
- [x] A3. `autoApprove` default decided and documented (2026-09-29) — **flipped
      from `true` to `false`** (R3 closed). The drivers were *already*
      fail-closed (`--auto` / `--sandbox danger-full-access` only when
      `autoApprove` is truthy); the permissiveness lived entirely in the two
      **caller** defaults, `autoApprove = true` in `submitTask`'s destructuring
      and `args.autoApprove !== false` in the MCP handler — the latter is the
      shape that reads an **omitted** `undefined` as true, so a caller who said
      nothing got `danger-full-access` from the handler before the runner's own
      default was ever consulted. Both are now opt-in. This is the safe
      direction and it is **free**: the whole headless path is behind
      `PADDOCK_TASK_QUEUE=1` and off, which is also why the item's stated
      premise ("`exec` now able to open TUIs") no longer holds — `autoApprove`
      never touched the Mission TUI path. Documented in both places the default
      was stated (the `zod` description *and* the tool description — the plan-60
      lesson that a fact carried in two fields must be fixed in both). Two
      tests, one per layer, because a control proved the MCP half was pinned by
      nothing: restoring the runner default turns 1 red, restoring the handler
      default turns 1 red **and leaves the other suite green**, which is what
      makes the two non-redundant.
- [ ] Gate: full `mission_*` + `pad_*` surface callable over live MCP with the
      intended keys; all test files green individually; `docker restart paddock`
      clean.

## Phase B — Playbook: the LLM's operating manual

- [~] B1. `llm-guide.js` becomes the session manual: the four-step flow (agent →
      project → session → work); **work the checklist in order, one item at a
      time, in a visible session, ticking each off** (53 **Phase 9** — *not*
      Phase 8, which was the MCP surface, shipped as plan 55) — that is how
      "do A then B then C" is executed, and the checklist (not a runner) is what
      survives a closed chat; use an existing session when one fits, else open
      one; read `mission_sessions` before typing into anything you didn't start;
      respect solo locks; memory discipline (read notes + checklist on arrival,
      write on decide); never start work the user can't see.

      **Status: 5 of 7 clauses DONE; 2 BLOCKED on 53 Phase 9 (not built).**
      Done and committed: the four-step flow (recipe 12/13), *reuse an existing
      session before opening one* (new caller rule + recipe 13 reorder), read
      `mission_sessions` before typing, respect solo locks, and never start work
      the user cannot see. The two remaining clauses — the ordered checklist and
      the notes on arrival / decisions — both name a **tool that does not
      exist**: there are no `mission_checklist` / `mission_notes` tables, and 53's
      Phase 9 is where they are meant to land. Writing those clauses now would
      teach an LLM to call a tool the server never registers, so a test now
      asserts the guide contains **no** pointer to an unbuilt checklist tool.
      B1 closes when 53 Phase 9 lands and the two clauses are added.
- [x] B2. Onboarding artifact (system-prompt snippet / skill, [51§4]) rewritten
      for the session model. No backend.

      **COMPLETE (2026-10-07) as the decided form (a): `pad_help`'s
      `GENERAL_GUIDE` IS the artifact, and this item was the audit of it. No new
      file.** (The "BLOCKED" reading below was resolved when the user chose
      (a).) Audit against the live tool surface found four gaps, all fixed in
      `src/services/llm-guide.js`:
      1. `mission_permission_answer` was never named anywhere in the guide, so a
         caller refused with `mission_permission_pending` had no recovery to look
         up. Now in the Mission section: a `△ Permission required` dialog is
         BLOCKED, not idle; detail shows `blockedOn: "permission"`; answer with
         `mission_permission_answer` (`once`/`reject`).
      2. The error-code list missed `mission_permission_pending`,
         `mission_not_an_agent` and `mission_tui_already_running` — the first was
         the recovery gap above; the second tells the caller not to `retype`
         (it would run as shell); the third tells them a relaunch would start a
         SECOND conversation in the pane. All three now named with their fix.
      3. `canSend` was absent, so `open` (live OR busy) could be read as the
         send verdict — but a solo-locked row and a permission-parked row are
         both `open` and both refuse typing. The guide now says `canSend` is the
         SAME check the write path applies and is the word that matters before
         typing.
      4. A `recreate`'s cost was unwarned: it kills every live Mission session
         on that PAD. The guide now says so, with the recovery (`restart` brings
         each back on the same conversation).
      Verified: `node --check` + mcp 140/140 (the B1 pin `reuse a session before
      you open one` intact). B1's 5/7 plus these four closed the B-phase's
      ownable items; only B1's two journal clauses remain, and they wait on 53
      Phase 9 (no `mission_checklist` / `mission_notes` tools exist yet).

      **BLOCKED — a user call, raised in `infinite.md`.** Two findings, both
      from reading rather than assuming:
      (1) **There is nothing to "rewrite".** No onboarding artifact exists:
      `src/views/onboard.ejs` is a dead EJS view (the only live `onboard` is
      `POST /api/agents/:name/onboard`, an agent-setup route), and no
      skill/prompt file is in the tree. So B2 is a **first** write, not a
      rewrite, and its **form** is still undecided — plan 51 §4 lists
      "My-LLM onboarding: system prompt snippet? skill file? slash commands?"
      under *"Open decisions (**user calls these**)"*. 51 is not in the queue, so
      that decision was never made.
      (2) **An onboarding artifact already exists and is better than a file.**
      `pad_help` serves `GENERAL_GUIDE` over MCP, it is the same module B1 just
      rewrote, it is **versioned with the code** so it cannot drift, and it is
      already session-shaped. A hand-maintained snippet would be a *second copy*
      of the same instructions with no sync story — the exact drift trap the
      guide is versioned to avoid. Your call: (a) treat `help` as THE artifact
      (then B2 is an onboarding-completeness audit of the guide, no new file),
      (b) write a separate static snippet/skill and say where it lives and how
      it is kept in sync, or (c) generate the snippet *from* the guide so there
      is one source. (a) or (c) recommended; (b) needs a home and a sync owner.

## Phase C — Prove it: the LLM drives a real session

- [x] C1. End-to-end over MCP on a real project, following 53 §1a: inspect →
      create project → open session → work → read back → journal. Narrated.

      **Status: COMPLETE (2026-10-07). The PATH is proven end to end, live, on
      TWO projects (paddock + test, below). The journal tail is blocked (53
      Phase 9) — `plan_activity` covers the read side, not `mission_checklist` /
      `mission_notes`. The C1-F1 Critical was resolved (R7/R8), so C2 counts.**

      **Run 1 — `msn_6056d53965f3c316` "C1 end-to-end proof", project `paddock`.**
      Reuse check first (B1's new rule): `mission_projects` → 13 sessions,
      `liveCount 0`; the 6 most recent were all `dead` and all the user's own
      unrelated conversations, so **nothing fit and the rule correctly declined
      to fire** — which is the result a reuse rule must be able to produce.
      Create-project was a genuine no-op: the project already existed. Start →
      `live: true`, `tuiAlive: true`, `inExpectedFolder: true`, and
      `createdBy: "key:key_748ebbc430e90484"` provenance stamped with no help.
      Send → text landed; read-back → `screenFrom: "live-pane"`, `canSend: true`.
      Answer was **18 `*.test.js` files**, and `ls -1 src/test/*.test.js | wc -l`
      outside the session returned 18 with the identical 18 names — so the
      read-back is a real answer, not just proof that text was typed. Closed
      with `mission_session_close` → `endedBy: "closed"`, row survived.

      **Run 2 — `msn_2a0e32253a88258f` "C1 busy proof"** (exists only to measure
      C1-F1). Answer **1331**, and `wc -l < AGENTS.md` outside returned 1331.
      Both sessions were told read-only and the worktree was unchanged after
      both (still the same 72 pre-existing WIP files).

      ### C1-F1 · Critical · **a fresh session can NEVER report `busy`**

      `agent_session_id` is **write-once from the caller's input**: the only
      write in the tree is the INSERT at `mission.js:214` from `startSession`'s
      `agentSessionId` argument, and there is no `UPDATE` anywhere. A freshly
      started session has no such argument — the page's "+ New session" calls
      `start()` with **no arguments** (`SessionList.jsx:454`) and
      `mission_session_start` only passes one if the caller supplies it — so the
      column is `NULL` **forever**, for human and agent starts alike. Then
      `stampTruth` computes
      `busy = !!(s.agent_session_id && probe.ids.has(s.agent_session_id))`, which
      is `!!(null && …)` = **`false` unconditionally**, while `busyKnown` is set
      from the *folder probe's* knowledge — so the row reports
      **`busy: false, busyKnown: true`**, i.e. "genuinely idle, the probe
      answered", at every moment of every fresh session.

      **Measured, not inferred.** Mid-turn on run 2, the pane showed
      `⬝⬝⬝⬝⬝ esc interrupt` — opencode actively working — while the same
      response carried `busy: false, busyKnown: true, canSend: true`. A caller
      following the guide's own rule (*"check `busy` first and only treat a
      session as quiet when `busyKnown` is true"*) is therefore **told it is
      safe to type** into a session that is mid-turn, and `mission_send`'s gate
      does not check `busy`, so the write goes through. The "don't talk over the
      human" property is inert on exactly the sessions an orchestrator makes.

      This is why the user's own rows all carry `ses_…` ids: they were **resumed
      from History** (the only caller that ever supplies one,
      `SessionList.jsx:400`). The defect was masked by the very habit B1 now
      recommends. Three consequences: (1) `busy` is inert for every fresh
      session, which is most of them; (2) `sessionTitle` returns `''`
      (`mission.js:1016`), so fresh rows never get a title; (3) `relaunch` /
      `restart` fall to `tuiLaunch.fresh()` and **orphan the conversation** —
      the code comment at `mission.js:727` says exactly that this must not
      happen — and the close response says so out loud: *"conversation: new
      (this row never recorded an agent session id)"*. The resumed-twin
      collapse at `mission.js:1389` filters on the same column, so it can never
      fire for a fresh row.

      **Two fixes, and they answer different questions — your call.**
      (a) **Stop the lie (cheap, fail-closed, one line):** return
      `busyKnown: false` when `agent_session_id` is null, so an unidentifiable
      conversation is **unknown, never idle** — exactly what plan 62 already
      does for the cwd-mismatch case (`mission.js:1064`) and what AGENTS.md
      demands of a failed probe. It does not make `busy` *work*; it makes the
      answer honest. (b) **Make it work (real fix, needs a design decision):**
      learn the conversation id for a fresh session — e.g. resolve the newest
      session in the folder created after the row's `created_at` from the
      agent's store — which also restores `title` and true resume, at the cost
      of being ambiguous when two sessions start in one folder at once.
      **(a) recommended now, (b) as the real fix**; the resume story (E4, R15)
      cannot be proven until (b) exists, because a fresh session has no
      conversation to resume.

      #### RESOLVED as to the id (2026-09-29) — and (b) is better done
      **up front than guessed afterwards.** `driver.createConversation(name,
      folder, containerPort)` now mints an empty conversation with opencode's
      own `POST /session?directory=…` **before** the pane is created, and the
      TUI is launched into it with `-s <id>`. The id is therefore a **fact at
      start time** rather than a deduction made later from timestamps — and the
      ambiguity the plan worried about is not narrowed, it **does not exist**:
      there is no window in which two fresh conversations could be confused,
      because we named the one we wanted. `createConversation` returns `''` on
      any failure, so a start that cannot mint still proceeds exactly as before
      (and then reports `busyKnown: false`, per (a)).

      **Proven live, not inferred.** A fresh REST start returned
      `agent_session_id: "ses_f1197271bffeuAGec4RCpGL4CE"` on its **first**
      response, and `ps` in the PAD shows the pane running
      `opencode -s ses_f1197271bffeuAGec4RCpGL4CE` — the TUI is genuinely
      resumed into the conversation we named, so `title` resolves from the
      store, and relaunch/restart come back to the same conversation. Both
      proof sessions were closed afterwards; the PAD's tmux was left with only
      its pre-existing `main` session.

      8 new tests (mission 105 → 113), covering: the mint happening before the
      launch and the launch being `-s <id>`; the folder and the PAD's **own**
      port being the ones used; a relaunch returning to the same conversation; a
      caller-supplied id winning so no second conversation is minted; **a
      deduped retry minting exactly one conversation** (the mint sits *after*
      the dedup check, or a timed-out client leaves an orphan per attempt); a
      start surviving a failed mint; a driver without the capability never being
      called. Two mutation controls in a throwaway copy: `if (false && …)`
      around the mint → 3 red; `const known = probe.known` (the fail-closed
      rule reverted) → 4 red. `mcp` 139/139 and the 7 other Mission-adjacent
      suites stay green.

      (a) is in the same change: `stampTruth` computes
      `known = probe.known && !!s.agent_session_id`, so a row with no id reports
      `busyKnown: false` on **all three** of its branches (live, dead, and
      shell) rather than only the cwd-mismatch one. The pre-existing test
      asserted `busy: false` for an id-less row and nothing about `busyKnown` —
      which is precisely why the lie survived a green suite: nothing in the
      response contradicted `busy: false` on its own.
- [x] C2. Every gap becomes an item; nothing advances until C1 is green **twice**
      — two projects, ideally two different models (the model-independence proof
      from [51§2b]).

      **COMPLETE (2026-10-07) — C1 green twice, two projects, model-independence
      clause filed as a gap.**

      **Run 3 (the C2 second-project proof) — `msn_97a8561eb03f6ac2`
      "C2 end-to-end proof (read-only)", project `test`
      (prj_106aafd00d478ddf, /www2/paddock-test2, pad-opencode-proj).** Reuse
      check first, exactly as C1: `mission_sessions` → 7 sessions, all `dead`,
      all the user's own conversations → nothing fit and the rule declined
      again. Start → `live: true`, `tuiAlive: true`, `inExpectedFolder: true`,
      `createdBy: "key:…"`, and `agent_session_id` minted on the **first**
      response (R7). Send read-only → detail showed the spinner, then the store
      answered: *"`.opencode/`, `AGENTS.md`, `opencode.json` — 3 entries (one
      hidden directory). Nothing changed."* — verified against the real
      directory (`ls -la /www2/paddock-test2` = exactly those 3), so the
      read-back is a real answer. Closed → `endedBy: "closed"`, `resumable`
      hint emitted. The worktree/folder was unchanged throughout (read-only
      discipline held).

      **Gap item filed:** the "two different models" clause cannot be proven —
      the fleet has only opencode pads (no codex/claude). Needs a codex pad:
      the user's call, since a new PAD is a spend.

## Phase D — Conferral + client keys

- [x] D1. Conferral: fleet-MCP wiring with the orchestrator grant on an ordinary
      PAD + folder-assignment config ([51§1b]). No new agent type. UI: the "Make
      orchestrator" button does it in one click; "Remove" reverses it.
      **Done (2026-10-07).** `services/orchestrator.js` confers/removes: it
      mints an `orchestrator` api key (`scopes: 'default'` — the user's call:
      the key that drives the fleet must be able to use every tool), wires the
      driver's connect builder into the pad (`docker exec -i … sh -lc` running
      the opencode builder, key on stdin → `paddock` MCP server with a bearer
      header), stamps `ORCHESTRATOR=1` + `orchestrator.json` (the folders-array
      file stays at `[]`; the folders EDITOR is deferred to Phase E2 as decided),
      one-pad-per-user exclusivity, and rolls back the key on a failed wire.
      Routes `GET|POST|DELETE /api/agents/:name/orchestrator` behind
      `requireOwnedAgent`; AgentHeader shows an Orchestrator brand badge +
      Remove when conferred, Make orchestrator otherwise. **Two live findings:
      (1)** the container's docker CLI HANGS a piped stdin under `execFile`
      `{input}` even for a trivial `read` — `spawn` + `child.stdin.write/end`
      works, which is also the "use spawn, not execFile" watch item already in
      AGENTS.md for openclaw auth; the hung exec left a full-reach key that no
      rollback could remove, so `execInPad` is spawn with a 60s kill-and-fail
      guard, and a hang now becomes `orchestrator_wiring_failed` + rollback
      instead of an orphaned key. **(2)** verified live end to end on a
      throwaway opencode pad: POST → pad's `opencode.jsonc` holds the paddock
      server and `opencode mcp list` reports `paddock connected`, GET reads
      `conferred:true`, DELETE revokes the key, clears the config entry and
      meta and returns `wiringLeftInContainer:false`; pad + key removed
      afterwards, no residue.
- [x] D2. Client keys: least-privilege keys for outside clients (phone,
      Telegram, a second LLM) — read-only by default, `exec` only when the user
      grants it. Listed where keys live today + per-key revoke.
      **Done (2026-10-07).** The Profile page's five scope boxes became six
      named presets — Full access / Full access (control) / Read-only / Client
      — read-only / Client — with terminal / Operator — exec + lifecycle —
      where `exec` rides `tools:exec` (A2's opt-in) and the lifecycle verbs ride
      `tools:lifecycle`, so "client with terminal" is expressible as
      `target:owned,tools:exec` without the base `read` (validateScopes refuses
      `read` + any `tools:*`). The form posts the scope STRING, not an array.
      Per-key revoke already exists (the keys UI); this phase made the grant
      expressible one-click.
- [x] D3. Namespace/grant split enforced server-side: a client key can never
      reach a session on a PAD it does not own.
      **Done (2026-10-07).** `missionVisibleAgents` narrows by
      `targetAllowed(user, n)` and the D3 negative test pins it across every
      plane: a `target:agent`-scoped key answers `mission_project_forbidden`
      for both the project_id and session_id reads on a foreign PAD, is refused
      `target grant` by `plan_list` and `exec` on that PAD, and still reads its
      own pad. The mutation control (dropping `&& targetAllowed` in
      `missionVisibleAgents`) turns exactly the D3 test red while the other 139
      stay green.

## Phase E — Guardrails (the surviving Criticals, pulled forward)

- [x] E1. **Audit log of agent actions** (R5, R13): who started a session, who
      typed into it, when — keyed to the API key. Without it, law 2 is
      unenforceable in practice.
      - `activity_events` already had the table, a writer and a reader, and its
        `actor` column had **never been set by anything** — all 702 rows read
        `system` (measured). So the log recorded *what* and could not answer
        *who*, which is the only question an audit log exists for.
      - `recordActivity` gained a 7th `actor` parameter defaulting to `system`,
        so all ~20 existing callers are untouched.
      - `mission.audit()` writes one row per action acting ON a conversation:
        `send`, `session_start`, `session_relaunch`, `session_restart`,
        `session_close` (row kept), `session_delete` (page Close), `project_create`.
      - Actor threaded from both surfaces in ONE vocabulary —
        `missionActor(user)` (`mcp.js`) / `missionActorFor(req)` (`app.js`),
        matching a row's existing `created_by` spelling (`key:<id>` / `user:<id>`
        / `system`).
      - **A send's text is never stored** — only line count and char length. A
        send is the human's own conversation and can carry a pasted secret; an
        audit trail is not a second copy of it.
      - A REFUSED send writes nothing, and a failing audit write never fails the
        action that already happened (tested by dropping the table mid-call).
      - Platform-initiated teardown (project-delete cascade) passes no actor, so
        it records `system` rather than crediting a human with a decision they
        never made.
      - 8 new tests (mission 97 → 105). Two mutation controls: disabling
        `audit()` → 6 red; forcing `actor` to `system` → exactly the 3
        attribution tests red. Both ran in throwaway copies, never in `/app`.
      - Live REST proof on `pad-opencode-proj`: `session_start`, `send` and
        `session_delete` all landed as `actor: user:admin_…`; the deleted
        session's id survives as `resource_ref` (its only remaining handle), and
        rows appear in the existing agent activity feed with no new reader.
      - **Defect found while testing:** the audit FK exposed that `mcp.test.js`
        deleted a parent `agents` row while its new `activity_events` children
        still pointed at it, failing all 50 of its own tests in `beforeEach`.
        Production was never affected — `removeAgentFromDb` clears the log
        first. Test cleanup now mirrors that order, and a control confirms the
        one-line revert reproduces 50 red.
- [x] E2. **Cost/spend visibility** (R1): sessions burn tokens invisibly *to the
      model* (a TUI runs whether or not anyone is looking). A per-PAD session
      count + age list on the Mission page is the minimum; a cap/kill-switch is
      the user's call (53 §11 Q6 is still open on capping agent-started
      sessions).

      **COMPLETE (2026-10-07) at the agreed minimum, live-verified.** Col-1
      project rows now render `N live · M sessions` (`msn-project-counts`, green
      dot when any session is live) from the server's `sessionCount`/`liveCount`
      — the `listProjects` → `withLive` → `withAgentBusyProjects` chain already
      computed them and the client dropped them. Verified in the browser: all 6
      projects show counts; mission 118/118. The per-session age list is col 2's
      `when(last_seen_at)` rows (already there). The cap/kill-switch remains
      open — 53 §11 Q6, the user's call.
- [x] E3. **Dead-session recovery story** (R9): a PAD restart kills every live
      TUI. The rows survive as dead, and the transcript is usually recoverable
      from the CLI's own store (`opencode.db` / `codex` rollout jsonl /
      `~/.claude/projects/*.jsonl`) — make that path explicit ("reopen this
      conversation") instead of implying the work is simply gone.

      **COMPLETE (2026-10-07) — the path is explicit and proven live.** The
      surface says it in words, not implications: `mission_session_close` /
      `mission_session_restart` respond with `resumable` (`via:
      mission_session_restart (same row, same tmux id)`, `conversation: same`,
      `agent_session_id`) and live sessions are resumed by `-s <id>`. Plan 68
      already reopens a dead session on row click. **Live proof (on the C2
      row):** restart of the closed row came back with the same `tmux_id` AND
      the same `agent_session_id`, `endedAt` cleared, and the store showed the
      SAME conversation (`messageCount` continued, not a fresh one). Recovery
      read: `plan_activity` reads exactly those stores (opencode.db exact-match
      / codex rollout jsonl / claude projects jsonl), available even when the
      PAD is stopped (`padRunning` vs `store.available` reported separately).
      No new code was needed — every piece already carried this; the item owed
      a proof and a record.
- [x] E4. **Resume proof** (R15): the amended law 3 depends on
      continue-latest actually working per driver. 53 Phase 5 builds the
      primitives; this phase proves the *cost* claim (resume is much cheaper
      than a new session) with real numbers.

      **COMPLETE (2026-10-07), proven live on opencode with the resumed C2
      conversation (ses_eed6b8b84ffen8Rde0jI1oFrdZ).** After the restart, the
      store row was the SAME conversation (`matched: exact`, messageCount 3 →
      5 as the resume added its two messages) — not a new empty one, so
      nothing was re-read. The resumed turn answered a *history-only* question
      ("what did you report earlier?") correctly, **zero tool calls, no `ls`,
      no re-list** (run 3's `lastToolCall` is run 1's `read`; the resume turn
      worked purely from context in <1s). The fresh-starts contrast is costed
      in this file: run 1 needed a `read` (the `ls`-equivalent) to produce the
      listing, and a fresh session would re-pay that every time; a resume pays
      ~nothing. Resumed-session capability is what R7 minting made reliable
      (the `agent_session_id` is named at start). Model caveat: proven on
      opencode; codex/claude need a pad (see C2's gap item).

## Phase F — LATER: homes modes (old 49 + plan 44)

Worktree/copy/volume backend + create/settings UI + volume lifecycle +
nested-docker registry. Unchanged by the rewrite — it is about *where* a PAD's
files live, not who orchestrates. [49§§0–8] holds the design; [49§6]
verification runs first inside this phase.

## Phase G — Closings (each gated on explicit user confirmation)

- [ ] G1. Docs absorb for keys/grants/conferral/playbook into `docs/`, then
      delete this file. Ordered after 53's absorb (53 §6) so the page is
      documented before the orchestration around it.
- [ ] G2. Optional cleanup decision, kept separate on purpose: remove or freeze
      `src/services/task-runner.js` and the `tasks` table now that nothing
      submits to them. **Not** part of A–E.

## Risk register (re-filed 2026-09-27 — retired entries moved to §3)

Format: ID · severity · owner phase · status. OPEN = must be decided before its
owner phase builds.

- [x] **R1 · Critical · Block E — cost caps.** **E2 minimum landed (2026-10-07):
      col-1 project rows now show `N live · M sessions`; per-session ages are
      col 2's rows. The ceiling/alert/kill-switch half stays open — 53 §11 Q6,
      the user's call.**
- [ ] R2 · Critical · Block C/E — injection path: repo text → agent output →
      orchestrator context → action. No provenance or output gates.
- [ ] **R7 · Critical · Block C/E (found by C1, 2026-09-29) — `busy` is
      structurally `false` on every fresh session**, so the orchestrator is told
      a working session is idle. `agent_session_id` is write-once at INSERT
      (`mission.js:214`) and a fresh start never supplies one (page
      `SessionList.jsx:454` calls `start()` with no args), so `stampTruth`'s
      `!!(s.agent_session_id && probe.ids.has(…))` can never be true, while
      `busyKnown` still reports the probe's `true`. Measured mid-turn:
      `busy:false, busyKnown:true, canSend:true` against a pane reading
      `esc interrupt`. Consequence: the "never talk over a live conversation"
      property is inert on exactly the sessions an agent creates, and the
      guide's own `busyKnown` rule endorses the interrupt. Also costs
      `sessionTitle` (always `''`) and real resume (`relaunch`/`restart` fall to
      `tuiLaunch.fresh()` and orphan the conversation, which `mission.js:727`
      explicitly says must not happen). Full evidence + the two fixes in §C1-F1.
      Cheap honest fix (a): stamp `busyKnown: false` when the id is null.
      Real fix (b): resolve the id for a fresh session. Blocks E4/R15, which
      cannot prove resume cost while fresh sessions have no conversation.
      **The id half is now DONE** (see §C1-F1 *RESOLVED as to the id*): the
      conversation is minted up front and the TUI launched into it, so
      `title` and real resume are back. **`busy` itself is still inert — see
      R8, which is a different root cause and is not fixed by having the id.**
- [ ] **R8 · Critical · Block C/E (found while fixing R7, 2026-09-29) — `busy`
      is inert for EVERY opencode session, because the busy probe is served by a
      different opencode process than the one running the TUI.**

      `agentWorkingSessions` asks the PAD's published web server
      (`opencode web --hostname 0.0.0.0 --port 7890`, pid 16) for
      `GET /session/status?directory=<folder>`. A mission session's TUI is a
      **separate** `opencode` process (pid 6458, `opencode -s ses_…`) that
      holds **no sockets at all** — it is a client, not a server, and it does
      not publish its live-work state to the web server. The two share the
      sqlite store (a `GET /session/{id}` against 7890 returns our conversation
      in full, so the store is shared) but **not** the live status.

      **Measured, not inferred.** With a turn in flight — the pane reading
      `⬝⬝⬝⬝⬝ esc interrupt` — `GET /session/status?directory=/www2/paddock`
      returned `{"ses_f13b1be56ffe3fPniszns5u9Ui":{"type":"busy"}}` for **42
      consecutive seconds**: the user's own *web-UI* session, never ours. Our
      id was absent at every poll, and `busy` stayed `false` throughout a turn
      that demonstrably ran. The endpoint is real and scoped correctly (AGENTS.md
      records it answering immediately for a folder-scoped turn) — it is simply
      answering about sessions **that server** is driving.

      **Why R7's fix does not fix this.** R7 removed the reason our id could not
      be looked up at all; now the lookup happens and finds nothing, so the row
      reports `busy:false, busyKnown:true` again — the *same* confident lie, one
      layer down. Fixing R7 without R8 would have left a defect that reads as
      fixed, which is the trap AGENTS.md warns about for a second source of
      truth.

      **A signal that does work, measured:** the agent's own store sees the turn.
      `agent-store.readActivity(pad, ses_…)` — already the `plan_activity`
      reader, already reachable from the webui container at
      `/workspace/instances/<pad>/opencode/data/opencode/opencode.db` — tracked
      it live across 15 polls: the newest tool part changed
      `bash/error → read/completed` while `lastActivityAt` stayed within 1–37s
      of now, i.e. it moved with the turn. Two candidate semantics, and they
      are **not** equivalent to today's: (i) newest tool part's own
      `state.status === 'running'` (precise for tool work, blind to prose
      streaming), or (ii) recency of `lastActivityAt` against a threshold
      (covers prose, but the threshold is a guess and no answer is
      self-evidently right). **This needs the user's call** — it changes what
      `busy` *means* across the page, `withAgentBusy` and the MCP surface, and
      it changes the documented cost model from **one probe per (PAD, folder)**
      to **one store read per session** (17 sessions on `pad-opencode-proj`;
      ~2 ms each, so cheap in absolute terms, but AGENTS.md's "never per row"
      liveness rule is a deliberate design constraint, not an accident).

      Also note this **invalidates one earlier measurement**: the first round of
      C1-F1 probing read tmux through a plain root `docker exec`, and this pad
      is `USER_MODE=user`, so its sessions live in `/tmp/tmux-1000` — that round
      was reading a *different, empty* tmux server and must not be cited as
      evidence. The pad's tmux is fine; the probe was wrong.
- [x] R3 · Critical · Block A — **RESOLVED (2026-09-29, A3): `autoApprove` is
      now opt-in**, in both caller defaults and both description fields. The
      drivers were always fail-closed; the permissiveness was `submitTask`\x27s
      `autoApprove = true` and the handler\x27s `args.autoApprove !== false`, the
      latter treating an OMITTED argument as true. Law 6 is why: the headless
      path runs where the user cannot see it. Free to fix — the path is behind
      `PADDOCK_TASK_QUEUE=1` and off.
- [ ] R4 · Critical · scope — docker socket = host escape for any holding PAD.
- [ ] R5 · Critical · Block E — orchestrator key: no rotation, no revocation
      drill, no audit log of its actions.
- [ ] R6 · Critical · Block F — copy-rebuild wipe guarded by a warning string.
- [x] **R9 · High · Block E — restart orphans live sessions.** **E3 COMPLETE
      (2026-10-07):** the recovery path is explicit (`resumable` on close/
      restart, `-s <id>` resume, plan 68 row-click reopen) and proven live — a
      closed row restarted into the same tmux + conversation, transcript
      intact.
- [ ] R11 · **RESOLVED (user, 2026-09-27): "prune nothing, let it grow."** No
      retention, no caps, no auto-delete; only explicit user deletes remove rows.
- [ ] R13 · High · Block E — no decision audit: why the agent opened/typed in a
      session is unrecorded.
- [x] **R15 · High · Block E — resume/continue unproven carrying the amended
      law 3.** **E4 COMPLETE (2026-10-07):** resumption returns to the SAME
      conversation (store row continues, messageCount 3→5) and a resumed turn
      answers history-out-of-context with zero tool calls, where the original
      needed a `read` — the "much cheaper" claim, measured.
- [ ] R16 · Medium · scope language — "perfect software" is not deliverable; the
      guarantee is "every defect visible, every failure recoverable, zero silent
      loss."
- [ ] R17 · Medium · process — paper outrunning proof. Mitigation: Phase A/C/E
      verifications are gates, not footnotes; no new plans until Block A is green.

## Traceability (where design detail lives — this file holds sequence only)

- Mission page, tables, `mission_*` tools, memory/journal: **plan 53**
- Steering design/token ladder/hooks (now largely superseded — §3): [48§H–K] ·
  Modes/semantics/safety/verify: [49§§1–8] · Bootstrap/lifecycle: [50§§2–9] ·
  Orchestrator/interface/context/omni-clients: [51§§1–2c,4]
- Terminal/tmux contract that sessions ride: `docs/reference/tabs/terminal.md`
