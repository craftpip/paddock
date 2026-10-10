# 82 — Per-project plans folder + plan lifecycle

## Status: Complete (2026-10-10) — all 8 phases done

Phases 1–8 are built, tested, and verified live:
- 1: schema + `plans_folder` migration (db)
- 2: project service normalization + `resolvePlansScope`
- 3: project-rooted `plans.js` (status mapping, INDEX, symlink containment, `containerViewOf` + webui mount-table resolver)
- 4: MCP `resolvePlansScope` + `plan_list`/`plan_write` + `plan_activity`
- 5: shared `plans.initProjectPlans` INDEX initialization wired into REST create route and `mission_project_create`
- 6: create/edit UI input ("Plans folder" field in ProjectDialog) + validation
- 7: guide prose updated (recipe 14 rewritten to project scope)
- 8: live browser verification (plan_write + listPlans round-trip on `/www1` mount), docs absorption, all suites green

Suites: plan-mcp 55, mcp 141, mission 125, db-migration 12 — all pass.

## Intent (verbatim, combined)
> when i'm creating a project in the missions page, in the create project popup
> give me option to set the plans folder path, by default its `plans/`.
> this will be the agent's working folder
>
> the plans folder is for in the workspace folder, `plans/`. check where we are
> referencing plans folder and replace with this dynamic value for the project.
>
> plan statuses: 1. new -> recently added 2. in progress -> the tasks that are
> working 3. blocked -> marked as blocked for some reason and needs intervention,
> stop where the agent finds this, don't proceed to next queue 4. need
> clarification -> there's a question or thing to be asked or sorted 5.
> done/review -> when the task is done. that's all there is, these are the rules.
>
> in the plans folder (whatever the user sets) in there create an `INDEX.md` file
> where u explain the rules of this folder. we already have a plans folder in
> this project and its rules, use those as baseline. `INDEX.md` file will be our
> entry file for the llm, to know us, tell about us and the role for the llm,
> what he has to perform.

## Agreed model
- A Mission project is `(agent, folder)`. Its **plans folder** is a path **inside
  its workspace/folder**, default **`plans/`**. So plans live at
  `<project.folder>/<plans_folder>/` — e.g. `/www1/craftpip.com/plans/`.
- The plans folder is a **per-project dynamic value**, set in the create/edit
  dialog. Every hardcoded `plans/` in the plans facility and its MCP surface must
   resolve through it. Unset → `plans`; project-scoped access roots that directory
   under the project folder. Legacy agent-only calls keep their PAD-root behaviour.
- The plans folder is **`INDEX.md`'s** home: the LLM's entry file for that
  project (rules, who we are, the LLM's role, what it must perform).

## Where `plans/` is referenced today (starting replace list)
| # | Location | What it is |
|---|----------|-----------|
| 1 | `src/services/plans.js:24` `PLANS_DIR='plans'` | the constant every path is built from |
| 2 | `plans.js:49-90` `plansRoot(agent)` | the PAD-workspace root; must become project-folder-rooted |
| 3 | `plans.js:101-104` `plansDir(agent,{archive})` | `<root>/plans` (+`/archive`); needs the per-project name |
| 4 | `plans.js:112-128` `planPath` + `planRel` | clamp relative to `plansDir` (keep the `..`-escape refusal) |
| 5 | `plans.js:145` `FRONTMATTER_KEYS` | frontmatter (session/created/started/last_activity/done) |
| 6 | `plans.js:190-193` `statusOf` | reads the `## Status:` line as free text → must know the 5 values |
| 7 | `plans.js:250-289` `listPlans` | skips `readme.md` → must also skip `index.md` |
| 8 | `plans.js:319-352` `README_BODY` + `ensureReadme` | the harness prompt → becomes `INDEX.md` (new content) |
| 9 | `plans.js:369-394` `writePlan` | calls `plansDir`/`ensureReadme` |
| 10 | `mcp.js:2542-2610` `plan_list`/`plan_write` | descriptions say `plans/`; `plansDir(row,…)` at :2563 |
| 11 | `mcp.js:2595` `plansFolder: dir` | internal plumbing name for the dir |
| 12 | `src/services/llm-guide.js:144-193` §Plans | prose says "under `plans/`", "the plans folder is per-PAD" |
| 13 | `docs/reference/backend/services.md` §Plans | doc absorb target |
| 14 | `AGENTS.md` (plan-status vocabulary) | repo-level `Complete/In progress/Proposed/Blocked/Draft` — reconcile |

## Current-code review and required corrections

Checked against the worktree on 2026-10-10. Line numbers above are navigation
hints; functions and contracts below are the implementation targets.

### Project identity and MCP scope

- `mission.createProject` explicitly permits duplicate `(agent, folder)` pairs.
  Therefore `{agent, folder}` is **not guaranteed unambiguous**. Add an optional
  `project_id` to both `plan_list` and `plan_write`. Resolve and authorize that
  project; require any supplied agent/folder to agree. A folder shorthand matching
  several visible projects must refuse with candidates rather than pick one.
- `plan_write` currently accepts only `agent`, `path`, `content`, `session`.
  Add project selection to the input schema, handler and shared resolver. A session
  binding is not a substitute: a new plan may have no session yet.
- `plan_list` currently rejects `path + folder`, and its `folder` is a filter on
  **session attribution**, not filesystem location (`scopeByProjectFolder`).
  Project-scoped listing/read/write must first select the project's directory;
  then allow `path` to select a file inside it. Update the refusal and its
  tests/descriptions explicitly. New unbound plans in that directory must appear.
- Keep agent-only calls as explicit legacy PAD-root mode; do not infer a project
  because one happens to exist today. An explicit bad/ambiguous project must never
  silently fall back to legacy `plans/`. Return the resolved scope and directory.
- `withSessionState` still enriches conversation activity. In project mode it must
  not determine which directory a plan belongs to or hide an unbound plan.
  Distinguish filesystem project scope from `sessionProject` when they differ.

### Filesystem resolution and initialization

- `plansRoot` maps the PAD workspace to a host-visible folder; a Mission project's
  `folder` is an **absolute container path**. Map that project path through the
  applicable mount before adding `plans_folder`; concatenating a container path
  onto the host root is incorrect. Reuse workspace access gates.
- `planPath` provides lexical containment today. Add real-path/symlink containment
  for the configured directory and file operations. Refuse inaccessible or
  read-only paths with their actual reason, not an empty plans list.
- Decide access capability explicitly for container-only projects. `workspace`
  has container-scope read/write operations, but `plans.js` reads through host
  `fs`. Extend the shared plans access layer consistently or surface unsupported
  access during configuration; changing a path string is not enough.
- `ensureReadme` runs only from `writePlan`; creating a Mission project does not
  create a plans folder or entry file. Creation/edit needs explicit initialization
  if INDEX is to exist before the first agent starts.
- `mission.createProject` / `updateProject` are synchronous DB operations, and the
  POST/PATCH routes in `app.js` call them synchronously. Put async filesystem
  initialization in a shared awaited orchestration path used by REST and MCP;
  update error handling and define partial failure/retry behaviour. Do not return
  a Promise where callers expect a project row.
- Keep existing README and INDEX content. Create INDEX only if absent; never
  automatically rename/delete README. The previous rename recommendation would
  move user data and conflicts with the preserve-originals rule.
- Editing `plans_folder` points future operations at the new folder; it does not
  move existing plans or queues. Report initialization failure, preserve the old
  files, and make retry safe. Coordinate an active runner with plan 83 so a path
  change cannot redirect it halfway through a task.

### Status and INDEX/QUEUE contracts

- `statusOf` reads text **on the same line** as `## Status:`. This plan's previous
  two-line header was invisible to it. Generate same-line canonical statuses;
  also handle existing next-line, bold, and dated headers without rewriting bodies.
- Return canonical status separately from `statusRaw`/status detail. Preserve an
  unknown value as unknown; never turn it into `new` or `done/review`. Specify
  legacy mappings in tests before changing the existing status API.
- Keep plan statuses separate from plan 83's queue statuses. `blocked` and
  `need clarification` both require the worker to set its queue item to
  `need input` with a reason, then stop. Whether human review is required before
  queue `done` must be stated in INDEX, not guessed by the runner.
- `INDEX.md` describes plans and links to **`QUEUE.md`**, which owns queue ordering,
  parser format and runner instructions. Do not generate competing queue rules.
  Skip README, INDEX and QUEUE in ordinary plan listings, and reserve those names
  from `plan_write` so plan frontmatter cannot corrupt instructions or the queue.
  Dedicated queue updates belong to plan 83.

## Plan statuses (the rules)
The five states, and they are the only five:

| Status | Meaning | Agent behaviour |
|--------|---------|-----------------|
| `new` | recently added | pick up in queue order |
| `in progress` | being worked | keep going |
| `blocked` | needs intervention | **STOP** — do not proceed to the next queue item |
| `need clarification` | a question must be asked/sorted | surface it, wait |
| `done/review` | the task is done | move to review/next |

- `statusOf` should recognise these (normalised, case-insensitive) and expose a
  canonical value on each `plan_list` row, so the listing/badge can be trusted.
- The **generated `INDEX.md`** states these rules verbatim (baseline = the repo's
  own `plans/README.md` + AGENTS.md plan-workflow rules, restated with this
  vocabulary).
- `blocked` / `need clarification` are **stop** states — the agent must not roll
  on to the next queue item. This is the core behavioural rule the LLM reads in
  `INDEX.md`.

## `INDEX.md` (entry file for the LLM)
Generated into each project's plans folder (created with the folder, like the
current README, and never overwritten once written — see gotchas). Contents:
1. **Who we are** — this project, the PAD it runs on, the workspace/folder.
2. **The folder's rules** — one file per piece of work; frontmatter is
   machine-managed; the body is the plan; archive to `archive/`.
3. **The LLM's role** — what it must perform (work the plans, one item at a time
   in a visible session, write decisions back).
4. **Statuses** — the five above, with the `blocked`/`need clarification` stop
   rule.
5. **The queue** — point to `QUEUE.md` for execution rules; plan blockers and
   clarification requests must be reflected there as `need input`.
- `listPlans` excludes `README.md`, `INDEX.md`, and `QUEUE.md`.
- Create INDEX when absent and preserve existing README/INDEX files. New folders
  receive INDEX as their entry file; existing files are not moved or overwritten.

## Proposed phases
1. **Schema** — add `plans_folder TEXT` to `mission_projects` (idempotent
   `ALTER` in `db.js`; a `db-migration.test.js` case derived from the real schema
   with a drop-the-migration control).
2. **Service** — `createProject`/`updateProject` accept `plansFolder`;
   normalise (relative, no `..` escape, no absolute) **server-side**; expose on
   the project row. Default `plans`.
3. **plans.js** — `plansRoot`/`plansDir` take an optional per-project plans
   folder resolved under the project `folder`; keep the clamp in `planPath`.
   `listPlans` skips README/INDEX/QUEUE. `statusOf` maps into the five states.
4. **Resolution** — `plan_list`/`plan_write` accept `project_id` and optional folder
   shorthand with ambiguity refusal. Resolve one authorized project before file
   access; allow project scope plus a file path. Agent-only calls retain legacy
   PAD-root mode, never a fallback for a failed project lookup.
5. **INDEX.md** — replace generation of `README_BODY`/`ensureReadme` with the INDEX
   content above, written through the workspace service. Add awaited project
   initialization and retry/error handling; preserve existing files.
6. **UI** — `ProjectDialog.jsx` gains a "Plans folder" `Input` (`msn-input-plans-
   folder` hook), default `plans/`, relative to the project folder; wired into
   create + update payloads; shown on edit.
7. **API + MCP** — pass `plans_folder` through `POST`/`PATCH
   /api/mission/projects` and `mission_project_create`; update descriptions and
   `llm-guide.js`.
8. **Docs absorb** — `docs/reference/backend/services.md` §Plans, tab docs,
   AGENTS.md status-vocabulary reconciliation; delete this plan.

## Test plan
- `mission.test.js` — create/update round-trips `plans_folder`; default when
  omitted; the folder must be inside the project folder (escape refused).
- `plan-mcp.test.js` — a project with a custom plans folder lists/writes there;
  `INDEX.md` is created and excluded from the listing; a `..` escape is refused.
- `db-migration.test.js` — new column + control (migration removed → red).
- `mcp.test.js` — `mission_project_create` accepts + echoes `plans_folder`.
- `plans` unit — `statusOf` maps all five states (case-insensitive) and leaves an
  unknown value surfaced rather than silently `null`.
- Project-scoped list/read/write use the same directory, including reading one
  file by project plus path, and listing a new plan with no session binding.
- Duplicate agent/folder projects require an ID; invalid/mismatched/unauthorized
  project selection never falls back to another path.
- Container-to-host translation, symlink escape, inaccessible/read-only folders,
  and initialization retry/partial failure preserve originals and report reasons.
- Existing README/INDEX are untouched; QUEUE is excluded and cannot be overwritten
  by `plan_write`. Changing the plans folder does not move the old files.
- Existing two-line/bold/dated status headers retain raw text and receive only the
  documented canonical mapping; unknown status never becomes actionable.
- **Live**: create a project with a custom plans folder in the browser, write a
  plan via MCP, confirm it lands at `<project.folder>/<plans folder>/…`, that
  `INDEX.md` exists with the rules, and that `plan_list` shows the row + status.

## Gotchas to respect
- **One writer, one gate.** `plans.js` writes files through `workspace.writeFile`
  / `createDirectories` (plan 64 3a/3d) — keep that; a private `fs.writeFileSync`
  would bypass the host-browsability gate.
- **Resolve + clamp server-side.** A client-supplied relative path must never
  escape the project folder; reuse the `planPath` `..` refusal.
- **`ensureReadme` is write-once.** Instructions that change under a mid-work
  caller are worse than none — do not overwrite an existing `INDEX.md`.
- **`check where we are referencing plans folder`** — the table above is a
  starting list, expanded by the review; `plansFolder` in `mcp.js` is internal plumbing, not the
  user value, and must not be confused with the new project field.
- **Don't rewrite the repo's own `plans/` semantics silently.** This repo's
  plans folder follows AGENTS.md's workflow; the generated per-project `INDEX.md`
  is a *baseline* of that with the new vocabulary. Aligning AGENTS.md is a
  separate, user-visible change.
- **`PLANS_DIR` is exported** and pinned by tests; adding a per-project override
  must keep the default so the fleet (`/www1` shared by three pads) is unaffected.

## Remaining design decisions
1. **Status matching strictness** — do we *normalise* any case/spelling into the
   five (e.g. `In Progress` → `in progress`), or require the exact lowercase
   string? (Recommend normalise + expose canonical, keep raw in `statusRaw`.)
2. **Legacy status mapping** — preserve raw legacy statuses and define the exact
   mappings, especially `Draft` and `Complete`, before changing API consumers.
3. **Relative base** — plans folder relative to the **project folder** (=
   workspace folder, recommended) — confirm that is "the workspace folder" you
   mean, vs the PAD's whole workspace root.
4. **Initialization failures** — define the persisted configuration and retry
   response if filesystem initialization fails after a project DB write.
5. **Review gate** — INDEX must state whether `done/review` allows queue completion
   immediately or requires human review, in which case QUEUE records `need input`.

## Progress

- [x] Capture requirements and the related plan 83 QUEUE.md contract.
- [x] Review current schema, project service/UI, plans helpers, MCP handlers and
  workspace access; correct scope, initialization and status-parsing assumptions.
- [x] Phase 1 — schema and migration.
- [x] Phase 2 — project service and validation.
- [x] Phase 3 — project-rooted plans access.
- [x] Phase 4 — shared API/MCP resolution and compatibility.
- [x] Phase 5 — INDEX creation and initialization.
- [ ] Phase 6 — create/edit UI.
- [ ] Phase 7 — API/MCP surface and guide updates.
- [ ] Phase 8 — verification, documentation absorption and plan completion.
