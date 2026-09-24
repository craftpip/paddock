# Plan 51 — The Orchestrator itself (a role on an ordinary PAD + fleet MCP)

## Status: [SUPERSEDED by plan 52 — do not build from this file; remaining work tracked ONLY in plan 52]  Draft (2026-09-24) — architecture declared by the user, design NOT
started. Inputs: plan 48 (task mechanics + steering), plan 49 (agent homes),
plan 50 (bootstrap runbook + lifecycle laws). Nothing here is verified
against code yet.
Build order: Block 6 (capstone, last). Master sequence: plan 48 “Build order”.

## 1. The user's architecture (verbatim intent — this is the capstone)

> The orchestrator in itself — I won't use my LLM. My LLM will talk to the
> orchestrator.

Three layers, fixed. No layer-skipping:

```
  my LLM (any model I chat with — conversational front-end)
      ↕ talks TO the orchestrator (goals in, status out)
  THE ORCHESTRATOR (itself an agent — persistent, Paddock-internal,
      owns the runbooks, the state, and the fleet)
      ↕ drives (dispatch, watch, steer, approve)
  worker PADs (do the work — plans 48/49/50)
```

Consequences, all non-negotiable:

1. **The orchestrator is an ordinary PAD plus a conferred role — no new agent
   type, no special creation flow** (user's simplification, aligned
   2026-09-24). You create it exactly like any agent, then wire the
   fleet-managing MCP into it with the orchestrator grant — that wiring IS
   what makes it the orchestrator. From that moment it has identity (it IS
   the `created_by`/`claimed_by` on the work it directs), a home (its own
   PAD: durable memory, folder-assignment config, run notes), and agency (it
   runs the plan-50 runbook itself). Revoke the wiring and it is a plain
   agent again — the role is conferred by configuration, never baked into a
   type. Run journals that survive webui restarts live in the DB (in-memory
   job logs do NOT satisfy plan 50 §8 law 1); the PAD holds the working
   memory, the DB holds the record — design says exactly what lives where.
2. **My LLM never touches workers directly.** All worker control flows
   through the orchestrator — one brain, no conflicting steers from two
  masters. The user's LLM sends GOALS ("start task X in project Y",
   "tell the agent to do it differently", "stop agent Z"); the orchestrator
   translates goals into mechanics (submit/watch/steer/approve/cancel). If a
   worker tool is reachable from outside the orchestrator, that is a bug.
3. **Lifecycle laws outrank requests (even mine).** Plan 50 §8 stands above
   every layer: if my LLM says "delete all agents and start over," the
   orchestrator must refuse-or-confirm per the laws (stop/create are
   human-confirmed; agents run forever). The user's LLM is powerful input
   and UNTRUSTED input at once — prompt-injection-aware by construction:
   goals are interpreted, laws are not negotiable by chat message.

## 1b. Conferring the role (mechanics — design must implement exactly this)

- **The act:** wire the fleet MCP into a running PAD with the orchestrator
  grant (full worker tools: submit/watch/steer/approve/cancel/priority/list).
  No UI type, no rebuild, no special image — the same `mcp add` flow every
  agent already has, with a grant no worker key ever holds.
- **Folder assignment:** the orchestrator owns folders via a small config in
  its home (e.g. `orchestrator.json`: `{ "folders": ["/host/projectA", …] }`
  — exact shape is design work). Multiple worker agents share one project
  folder; they all point back to the folder's orchestrator. Inventory
  (plan 50 §3) reads this config to answer "who owns this folder".
- **One or many:** one central orchestrator for all folders vs one per
  project — open (plan §4 decision). The conferring act is identical either
  way, so the decision upgrades without rebuilds.
- **De-conferring:** revoke the grant / remove the wiring → plain agent
  again, journals stay in the DB. No data loss path by design.

## 2. The interface (user-LLM ↔ orchestrator contract — design must fix exactly)

The orchestrator exposes a SMALL stable surface to my LLM. Candidate verbs
(design finalizes; no more than this shape):

- `start_project { folder, goal }` → bootstrap per plan 50 (inspect →
  inventory → devcontainer → setup-start-or-propose → dispatch).
- `project_status { folder }` / `task_status { task_id }` → observe (reads).
- `steer { task_id, message }` → plan 48 §H redirect ladder.
- `approve { task_id, decision, note? }` → plan 48 §H gate.
- `stop_agent { name }` → relayed user instruction per plan 50 §8 law 2
  (the orchestrator records WHO ordered it).
- `report { run }` → what happened, tokens spent, what was accepted.

Transport options (design picks ONE for v1, recommended first):

1. **MCP-first (recommended).** The orchestrator speaks MCP to my LLM as
   client — model-agnostic (Claude, ChatGPT, anything with an MCP client),
   matches "my LLM talks to the orchestrator" literally, and reuses our
   existing MCP auth/grant machinery. v1: expose §2 verbs as MCP tools on a
   dedicated orchestrator endpoint/namespace, separate from worker tools.
2. ChatOps relay (chat bridge drives runs — Bernstein does this; heavier).
3. Plain REST alongside MCP (for scripting; NOT instead of MCP).

v1 rule: worker tools and orchestrator tools are DIFFERENT namespaces with
DIFFERENT grants. A key that talks to the orchestrator cannot steer a worker
directly (consequence #2, enforced).

## 2b. Context & continuation across multiple LLMs (user's requirement)

> Multiple LLMs handling the work won't have the same context. The
> orchestrator is a different agent running in itself, with its own context;
> other LLMs using the Paddock MCP talk to it.

The model, stated once: **the orchestrator owns the durable shared context;
every other LLM is a stateless client that rehydrates per call.** No shared
window is ever assumed — the protocol is state-transfer, not shared memory.

- **Orchestrator context (durable, the source of truth):** run journals, task
  rows + steering logs + approvals (plans 48/50), requirements discovered at
  bootstrap, decisions taken and why. Lives in the DB (+ manager home files
  if file-backed — §4 decision). The orchestrator's LIVE context is rebuilt
  from this store every turn and every restart: rehydration is a designed
  protocol step, not an accident of a long-lived process.
- **Caller LLMs (stateless):** my chat LLM today, a different model
  tomorrow, worker LLMs in PADs — each arrives with its own (possibly empty)
  context. Every orchestrator response therefore carries the context the
  caller needs to continue: status payloads include history (steering tail,
  turn count, approvals, prior result summaries), never just the current
  state. Full detail stays one call away (`task_result`-style depth on
  demand; summaries by default — the same capsule discipline as plan 48's
  `result_summary` vs capped raw output).
- **Handoff capsule (exact shape is design-phase work; the fields are
  fixed):** `{ goal, history_tail, decisions, steering_log, next_step }` —
  everything a fresh LLM needs to pick up mid-run with zero prior context.
  A continuation test MUST pass with a different model than the one that
  started the run (design proves model-independence, not just
  restart-recovery).
- **Restart recovery:** orchestrator process dies → on boot it reloads open
  runs from durable state, reconciles (plan 47's orphan-reconciliation
  pattern extended from tasks to runs: `running` with no live child →
  marked, reported, never silently resumed), and continues. "Up all the
  time" (plan 50 §8.1) means the FLEET stays up; the orchestrator itself may
  restart as long as no run state lives only in its memory — anything
  memory-only is a bug by definition.
- **Isolation:** one LLM's confusion cannot corrupt another's context. Caller
  messages are INPUT (validated against lifecycle laws per §1.3); only the
  orchestrator writes shared state, and only through its own gated paths.
  A worker hallucinating "task done" doesn't complete the run — gates and
  approvals do (plan 50 §9).

## 2c. Omni-client access (user's requirement — Telegram/phone/any LLM)

> I can connect to Paddock MCP from my phone, my Telegram, or any other LLM
> and continue the task same as before. Give a task in Telegram, check
> progress from anywhere — as long as all those methods use Paddock MCP.

MCP is THE interface, and every client is just another stateless MCP client
of the orchestrator. Telegram bot, phone app, desktop LLM, web UI — four
windows onto ONE durable state (§2b). Start a task from Telegram on the bus,
check the tail from your phone, steer it from your desktop LLM at home: same
run, same history, zero re-explaining. That continuity is not a feature to
add — it FALLS OUT of §2b if the interface stays uniform. Design protects it
with three rules:

1. **One protocol, thin adapters.** Telegram/phone are bridges (borrowing
   Bernstein's `chat serve` shape: `/run /status /approve /reject /stop`
   mapped onto §2 verbs), never second orchestrators. A bridge holds no run
   state — it renders orchestrator payloads and forwards user messages. If a
   bridge ever needs its own database, the design has rotted.
2. **Payloads stable, rendering per client.** The orchestrator returns the
   same capsule shapes to every client; each client renders what fits its
   medium (Telegram: short text + approve/reject buttons; phone: compact
   cards; desktop LLM: full depth). A `verbosity: full | tail` parameter on
   read verbs (design fixes the default per verb) so narrow channels never
   drown and rich ones never starve.
3. **One key per client, least privilege each.** Phone key, Telegram bridge
   key, desktop-LLM key: separate API keys, individually revocable, grants
   matched to the channel (e.g. a watch-only key for a status dashboard; a
   Telegram key WITH approve but WITHOUT agent-stop if the user wants the
   pocket remote safer than the desk). Compromised phone → revoke one key,
   runs continue everywhere else untouched.

## 3. Internals (how it uses the other plans — referenced, not repeated)
- Runbook = plan 50 (§2–§6 bootstrap, §8 lifecycle laws, §9 perfect-software
  loop). The orchestrator doesn't HAVE the runbook — it IS the runner of it.
- Mechanics = plan 48 (submit/watch/steer/approve/cancel/priority). Design
  decides call path: direct service calls vs loopback MCP. v1 guidance:
  loopback MCP (ONE code path for manager-driven and orchestrator-driven
  actions — no logic fork to rot).
- Homes = plan 49 (bind/copy/volume) + manager home (plan 50 §8b — the
  orchestrator's home PAD is where its journals/notes live if file-backed).
- Manager-control (plan 48 §K) moves INSIDE: what §K gave "the manager over
  MCP" the orchestrator now holds natively; the human reaches it only
  through my-LLM → orchestrator requests.

## 4. Open decisions (user calls these)

- [ ] Transport v1 (§2): MCP-first vs REST-first — user confirms.
- [ ] Durable state shape: DB tables (runs? journals?) vs manager-home files
      — design proposes after Phase 0 code read.
- [ ] My-LLM onboarding: how does my LLM learn the §2 verbs (system prompt
      snippet? skill file? slash commands?) — a real artifact, not vibes.
- [ ] Multi-user: one orchestrator per Paddock, or one per user/owner?
      (Defer if single-user v1 — but decide explicitly, not by accident.)

## 5. Out of scope

- Worker mechanics (plan 48), homes (plan 49), runbook steps (plan 50) —
  referenced, never re-designed here.
- Autonomous fleet changes (plan 50 §8 forbids; restated so no reader of
  THIS plan invents them).
- Human UI for orchestration (board/timeline views are future frontend
  plans; the orchestrator must be fully drivable without them).

## 6. Phases (sketch)

- [ ] Phase 0 — code read: MCP serve path, grants, task-runner internals,
      job-log volatility (prove the durability gap), auth/key model.
- [ ] Phase 1 — interface contract (§2 verbs, schemas, namespace + grants)
      as a written spec + my-LLM onboarding artifact (§4).
- [ ] Phase 2 — orchestrator core: goal intake → runbook execution → durable
      state → worker calls via loopback; lifecycle laws as code gates
      (refuse-or-confirm, tested adversarially: "delete everything" must fail
      closed).
- [ ] Phase 3 — live proving: my-LLM → orchestrator → workers on a real
      project, full §9 loop to accepted, narrated.
- [ ] Phase 4 — absorb into `docs/` and close. Gated on explicit user
      confirmation (house rule).

## Verification (house rule + one addition)

- Standard: `docker restart paddock`, individual test files, live browser
  proof where UI touches.
- Addition for THIS plan: an adversarial pass — feed the orchestrator
  law-breaking requests ("stop all agents", "delete the fleet", "skip the
  gates and call it done") and prove each fails closed before Phase 3 counts.
