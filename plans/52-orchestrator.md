# Plan 52 — Orchestrator (session-based: keys, grants, conferral, playbook, proof)

## Status: Rewritten (2026-09-27) — **0/7 phases built.** The queue is gone;
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
- **Context (53 Phase 8):** notes + run-journal read/write, keyed to
  `project_id` (+ optional `session_id`).
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

- [ ] A1. Grant model audit + complete: the bucket set (`read`/`create`/`exec`/
      admin), `TOOL_GRANT_FOR` completeness (verify every registered tool has an
      entry — `task_steer` was missing from the map when this was written, which
      is how a grant silently defaults), per-PAD scoping, revocation.
- [ ] A2. Mission grants: `mission_projects`/`mission_sessions` → `READ_TOOLS`;
      `mission_project_create` → `create`; `mission_session_start`/`mission_send`
      → `exec`. Implemented in 53 Phase 7, **verified here** with the
      fail-closed proof (a key without `exec` gets `Not permitted by API key
      tool grant: mission_send`).
- [ ] A3. `autoApprove` default revisited (R3): today it is maximally
      permissive; with `exec` now able to open TUIs, decide and document the
      default.
- [ ] Gate: full `mission_*` + `pad_*` surface callable over live MCP with the
      intended keys; all test files green individually; `docker restart paddock`
      clean.

## Phase B — Playbook: the LLM's operating manual

- [ ] B1. `llm-guide.js` becomes the session manual: the four-step flow (agent →
      project → session → work); use an existing session when one fits, else open
      one; read `mission_sessions` before typing into anything you didn't start;
      respect solo locks; memory discipline (read notes/journal on arrival, write
      on decide); never start work the user can't see.
- [ ] B2. Onboarding artifact (system-prompt snippet / skill, [51§4]) rewritten
      for the session model. No backend.

## Phase C — Prove it: the LLM drives a real session

- [ ] C1. End-to-end over MCP on a real project, following 53 §1a: inspect →
      create project → open session → work → read back → journal. Narrated.
- [ ] C2. Every gap becomes an item; nothing advances until C1 is green **twice**
      — two projects, ideally two different models (the model-independence proof
      from [51§2b]).

## Phase D — Conferral + client keys

- [ ] D1. Conferral: fleet-MCP wiring with the orchestrator grant on an ordinary
      PAD + folder-assignment config ([51§1b]). No new agent type. UI: the "Make
      orchestrator" button does it in one click; "Remove" reverses it.
- [ ] D2. Client keys: least-privilege keys for outside clients (phone,
      Telegram, a second LLM) — read-only by default, `exec` only when the user
      grants it. Listed where keys live today + per-key revoke.
- [ ] D3. Namespace/grant split enforced server-side: a client key can never
      reach a session on a PAD it does not own.

## Phase E — Guardrails (the surviving Criticals, pulled forward)

- [ ] E1. **Audit log of agent actions** (R5, R13): who started a session, who
      typed into it, when — keyed to the API key. Without it, law 2 is
      unenforceable in practice.
- [ ] E2. **Cost/spend visibility** (R1): sessions burn tokens invisibly *to the
      model* (a TUI runs whether or not anyone is looking). A per-PAD session
      count + age list on the Mission page is the minimum; a cap/kill-switch is
      the user's call (53 §11 Q6 is still open on capping agent-started
      sessions).
- [ ] E3. **Dead-session recovery story** (R9): a PAD restart kills every live
      TUI. The rows survive as dead, and the transcript is usually recoverable
      from the CLI's own store (`opencode.db` / `codex` rollout jsonl /
      `~/.claude/projects/*.jsonl`) — make that path explicit ("reopen this
      conversation") instead of implying the work is simply gone.
- [ ] E4. **Resume proof** (R15): the amended law 3 depends on
      continue-latest actually working per driver. 53 Phase 5 builds the
      primitives; this phase proves the *cost* claim (resume is much cheaper
      than a new session) with real numbers.

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

- [ ] R1 · Critical · Block E — cost caps: sessions burn tokens whether or not
      anyone is watching; no ceiling/alert/kill-switch.
- [ ] R2 · Critical · Block C/E — injection path: repo text → agent output →
      orchestrator context → action. No provenance or output gates.
- [ ] R3 · Critical · Block A — `autoApprove=true` default, now able to open
      TUIs.
- [ ] R4 · Critical · scope — docker socket = host escape for any holding PAD.
- [ ] R5 · Critical · Block E — orchestrator key: no rotation, no revocation
      drill, no audit log of its actions.
- [ ] R6 · Critical · Block F — copy-rebuild wipe guarded by a warning string.
- [ ] R9 · High · Block E — restart orphans live sessions (rows dead, TUIs gone).
- [ ] R11 · **RESOLVED (user, 2026-09-27): "prune nothing, let it grow."** No
      retention, no caps, no auto-delete; only explicit user deletes remove rows.
- [ ] R13 · High · Block E — no decision audit: why the agent opened/typed in a
      session is unrecorded.
- [ ] R15 · High · Block E — resume/continue unproven carrying the amended law 3.
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
