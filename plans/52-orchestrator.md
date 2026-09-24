# Plan 52 — Orchestrator (unified master: tasks, homes, runbook, capstone)

## Status: In progress (2026-09-24) — unified from plans 47/48/49/50/51 per
user instruction ("all orchestration plans as one plan, shuffle freely").
Design detail lives in the source plans (referenced per task as [47§x]);
THIS file is the single build sequence. Source plans are superseded as
standalone builds — their remaining work is tracked ONLY here. Block order
per user: homes first, then mechanics, then runbook, then capstone.

## Governing laws (apply to every task below — from [50§8], [48§K], [51§1])

1. Lifecycle (corrected 2026-09-24 — run-forever is impossible): workers
   STOP when idle (no running/claimed tasks for N minutes — N is design
   work) and WAKE on dispatch (orchestrator starts the PAD when a task
   arrives; start is cheap, automatic, already approved). Stop ≠ delete:
   volumes/worktrees/copy-dirs persist, so wake-up loses nothing. Only the
   orchestrator PAD itself stays up (it's the front door — one container;
   everything else scales to zero). Stop remains user-relayed ONLY for
   explicit stop orders; idle-stop is automatic housekeeping, delete is
   human-confirmed, always.
2. One holder, no layer-skipping: only the orchestrator PAD (role conferred
   by fleet-MCP wiring, [51§1b]) calls worker tools. Outside LLMs get
   orchestrator-verbs only. ([48§K], [51§1])
3. Token ladder: pull-steer (~free) → resume-steer (delta only) →
   resubmit (last resort, documented waste) → early-stop on stale
   heartbeat. ([48§H.1])
4. Additive-only on existing paths; lifecycle laws outrank any request,
   including the user's own chat messages. ([49§5], [51§1.3])
5. Done = proven: unit tests green, restart, live-verify (throwaway PAD +
   browser where UI touches) before any task counts. Docs absorb per plan,
   each gated on explicit user confirmation.

## Modes: orchestrator optional, direct by default (user requirement)

Two ways to run, same tools underneath. The orchestrator is OPTIONAL — my
LLM can also be the orchestrator directly:

- **Direct mode (DEFAULT, zero setup).** My LLM holds a full-grant MCP key
  and calls worker tools (`task_submit/steer/approve/…`) itself. Setup =
  copy the key. Nothing to create, nothing to wire, nothing to learn. This
  is the day-one experience and it never goes away.
- **Orchestrator mode (one-click upgrade).** One PAD gets the fleet MCP
  wired with the orchestrator grant ([51§1b] conferral) and becomes the
  orchestrator; outside LLMs drop to orchestrator-verbs. For when runs get
  long, multi-client (Telegram/phone), or multi-model — the cases where a
  persistent mind with durable memory earns its keep.
- Downgrade is symmetric: unwire → back to direct, journals stay in the DB.
  No mode traps the user.

Frontend reality check (user, 2026-09-24): today's frontend is agent
list + create + use + delete ONLY. So there are NO new screens — ever, in
this plan. Concretely:

- Direct mode needs no UI beyond what key-copy already exists (VERIFY: MCP
  API-key copy in current UI; if missing, the smallest possible addition —
  a copy button where keys are managed — is part of Phase B, not a screen).
- Orchestrator mode = ONE button on the existing agent detail ("Make
  orchestrator" / "Remove") + ONE status chip in the agent list
  (Direct / Orchestrator: \<pad\>). Both ride existing surfaces.
- Folder assignment ([51§1b] config), grants, namespaces: files/keys under
  the hood, editable where configs are already edited today. No dedicated
  orchestration UI anywhere in Phases A–G. If a task seems to need a new
  screen, redesign the task, not the frontend.

## Phase A — homes backend [49§§0–1,4b] (FIRST)

- [ ] A1. Read-only verification of [49§6] checklist (meta keys, compose
      emission point, per-PAD build pipeline COPY feasibility, settings
      flow, devcontainer-vs-non-bind, deletion path). Record findings in
      [49§6]. No code changes.
- [ ] A2. `WORKSPACE_MODE` meta (`bind|worktree|copy|volume`, absent = today)
      + per-mode compose emission as NEW functions in `vm-manager.js` (old
      bind lines untouched) + worktree create/remove helpers + nested-docker
      registry fields (port block, compose `-p` name, volume prefix).
- [ ] A3. Unit tests: compose output per mode + rebuild semantics. Gate:
      green + `docker restart paddock` + throwaway-PAD live verify.

## Phase B — un-break + observe [48 Phases 1–3]

- [ ] B1. `task-runner.js`: `taskCapability` accepts cap objects; fix
      `module.exports` (drop phantom `buildCommand`/`extractSummary`, export
      `buildExecCommand`+`taskCapability`); `killTask` clears flush timer.
- [ ] B2. `db.js`: `last_output_at` column + ALTER guard (owner_id pattern).
- [ ] B3. `src/test/tasks.test.js` → plan-48 API (schema + driver-cap command
      tests + codex-accepted/openclaw-rejected + heartbeat + extractors).
      Gate: `tasks.test.js` + `mcp.test.js` green individually.
- [ ] B4. `src/mcp.js`: `task_watch` + read bucket + `task_submit`
      description (multi-driver). Tests for watch/terminal/wait + scoping.
- [ ] B5. Live verify on real PADs + **H.3 resume research**: opencode/codex
      session-continue round-trips, exact flags recorded in [48§H.3]. Its
      outcome fixes Phase C's architecture — no dead flags either way.

## Phase C — hands [48 Phase 4, primary feature]

- [ ] C1. `db.js` migration: `steering/steered_from/session_id/turn_count/
      approval` columns.
- [ ] C2. `task_steer` (note/stop/redirect; push resume-steer via
      `detachChild` + same-row re-attach, resubmit fallback with
      `steered_from` link; pull redirect flag) + `task_approve`
      (+`needs_approval` submit flag; reject auto-appends redirect).
      [48§H.2–H.3]
- [ ] C3. Driver resume trio (`supportsResume/resumeCommand/sessionId`) ONLY
      for drivers B5 proves; others ship without and take the fallback.
- [ ] C4. Worker re-read contract in `llm-guide.js` + steer loop playbook.
      Gate: [48§H.4] test list green + live steer demo (note → redirect →
      resumed tail) on a real PAD.

## Phase D — home UI [49 Phases 2–4 + plan 44 merged here, once]

- [ ] D1. Create form: mode selector + per-mode fields/validation.
- [ ] D2. Settings: show mode, guarded switches, copy-rebuild warnings,
      orchestrator-assigned registry fields (read-only).
- [ ] D3. Volume lifecycle: list/show/delete + orphan accounting.
      Gate: browser-verify create + settings pages live.

## Phase E — runbook [50 Phases 1–2]

- [ ] E1. Bootstrap checklist in `llm-guide.js` (inspect → inventory →
      devcontainer → start-or-propose → dispatch) with lifecycle laws as
      checklist gates (never prose advice). Uses Blocks A–D only.
- [ ] E2. Only the backend gaps E1 proves missing (scout path, inventory
      filter, idempotency guard). Gate: live manager walkthrough on a
      throwaway folder, narrated end to end (setup → dispatch → steer →
      accept).

## Phase F — guardrails [48 Phase 5]

- [ ] F1. `PADDOCK_TASK_PRE_SUBMIT` (fail-closed) + `PADDOCK_TASK_POST_COMPLETE`
      (fire-and-forget) + pull-path claimed_by/agent_name mismatch warning.
      Gate: refuse path, f&f logging, mismatch tests green.

## Phase G — capstone [51]

- [ ] G1. Conferral: fleet-MCP wiring with orchestrator grant on an ordinary
      PAD + folder-assignment config ([51§1b]). No new agent type. UI: the
      "Make orchestrator" button on agent detail does this in one click
      (wires fleet MCP in + creates the config); "Remove" reverses it.
- [ ] G2. THE TWO SURFACES (user-derived, 2026-09-24 — this is the setup):
      (a) Fleet MCP (exists today: task_submit/watch/steer/approve/cancel…)
      gets wired INTO the orchestrator PAD so it can drive workers;
      (b) Orchestrator MCP (NEW: start_project/project_status/steer/approve/
      stop_agent/report per [51§2]) is what the orchestrator serves OUT to
      my LLM, phone, Telegram — each with its own least-privilege client
      key. Namespace/grant split enforced server-side: a client key can
      never reach a worker tool. UI for (b): client keys listed where keys
      live today + per-key revoke; no new screen.
- [ ] G3. My-LLM onboarding artifact ([51§4]) + omni-client bridges (thin,
      stateless).
- [ ] G4. Adversarial proving: law-breaking requests ("delete everything",
      "skip the gates") fail closed; continuation test with a DIFFERENT
      model than the starter. Gate: all fail-closed proofs pass.

## Phase H — closings (each gated on explicit user confirmation)

- [ ] H1. Plan 47 Phase 5 docs absorb (4/5 done; only docs remain).
- [ ] H2. Plans 48/49/50/51 docs absorb into `docs/` per each plan's closing
      phase, then delete source files. Order: 48 → 49 → 50 → 51.

## Risk register (filed 2026-09-24 — full disclosure, user-ordered into decisions below)

Format: ID · severity · owner phase · status. OPEN = must be decided/designed
before its owner phase builds. Severity = Critical (money/loss/safety),
High (correctness/trust), Medium (hygiene/scope).

- [ ] R1 · Critical · Block B — cost caps: no ceiling/alert/kill-switch on
      token/API burn anywhere. A loop burns money silently.
- [ ] R2 · Critical · Block C/G — injection path: repo text → worker output
      → orchestrator context → action. Zero mechanisms (no provenance, no
      output gates, no destructive-action confirms).
- [ ] R3 · Critical · Block B — `autoApprove=true` default: maximum
      permissiveness out of the box.
- [ ] R4 · Critical · Block 0/2 scope — docker socket = host escape for any
      holding PAD. No sandbox tiers, no egress policy.
- [ ] R5 · Critical · Block G — orchestrator key: no rotation, no revocation
      drill, no audit log of its actions.
- [ ] R6 · Critical · Block D — copy-rebuild wipe guarded by a warning
      string. Needs hard confirm + pre-rebuild snapshot.
- [ ] R7 · High · Block C — steering column read-modify-write race:
      concurrent steers lose one. Needs atomic append or steering table.
- [ ] R8 · High · Block C — double-steer race in kill/resume window: no row
      locking/state machine. Double spawn or spawn-on-dead-row possible.
- [ ] R9 · High · Block B — restart orphans live container-side agents: rows
      marked error, processes keep burning untracked. VERIFY + kill-or-adopt
      on boot.
- [ ] R10 · High · Block C/G — no submit idempotency: client retry
      double-dispatches. Needs client-supplied idempotency key.
- [ ] R11 · Medium · Block F/H — tasks table grows forever (per-second
      flushes, no retention); backup coverage of task/run tables unverified
      (plan 26).
- [ ] R12 · High · Block C/E — self-reported `done`: acceptance is prose,
      not enforced. Needs evidence-gated completion states.
- [ ] R13 · High · Block G — no decision audit: why the orchestrator steered/
      stopped/approved is unrecorded. State without explainability.
- [ ] R14 · Medium · Block C — no alerting on stuck tasks (stale heartbeat
      waits for a poller). Needs push/notify path.
- [ ] R15 · High · Block B outcome — resume unproven carrying Phase C; its
      fallback is the forbidden token waste. B5 must produce a third option
      if resume fails (constrained resume? checkpoint-inject?).
- [ ] R16 · Medium · scope language — "perfect software" is not deliverable;
      the guarantee is "every defect visible, every failure recoverable,
      zero silent loss." Redefine done accordingly (as governing-law
      amendment when user confirms).
- [ ] R17 · Medium · process — paper outrunning proof (6 plans, 0 built;
      every unverified assumption load-bearing). Mitigation: Phase A1/B5
      verifications are gates, not footnotes; no new plans until Block B is
      green.

## Traceability (where design detail lives — this file holds sequence only)

- Steering design/token ladder/schemas: [48§H] · Hooks/fences: [48§I] ·
  Segment map: [48§J] · Control: [48§K] · Build research: [48§H.3]
- Modes/semantics/safety/verify: [49§§1–8] · Nested-docker: [49§4b]
- Bootstrap/devcontainer/lifecycle/perfect-loop: [50§§2–9]
- Orchestrator/interface/context/omni-clients/decisions: [51§§1–2c,4]
