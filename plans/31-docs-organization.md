# Goal 31 — Documentation Organization: one format, one guide, a reviewed corpus

> **Status: Plan / not yet started.** User request: "organize the documentation
> folder, add more documentation, review what's going on, and make it organized
> with one formatting and one consistency. I want a parent documentation file
> which describes how to write the documentation — how to format it and all.
> Check online for nice rules / agent files for this."
>
> This plan defines the conventions, the parent guide, the review pass over
> existing docs, and the gap list for new docs.
>
> **Status 2026-08-09:** Phase 1 done. Parent doc created as
> `docs/STYLE-GUIDE.md` (user decision — CONTRIBUTING.md is for "how to
> contribute"; this file is formatting rules, so the style-guide name fits).
> README.md updated to index + link it. `.markdownlint.jsonc` NOT created yet
> (config is inline in the guide; decide in open question 2).

## The one rule (goal)

One parent file, `docs/CONTRIBUTING.md`, is the single authority for how every
document in `docs/` is written and structured. If a doc disagrees with the
guide, the doc gets fixed — not the guide. The whole corpus is then audited
against it once, and new docs follow it from day one.

---

## Research — what the web says (sources)

The user asked for "nice rules / agent files" for writing documentation. The
useful patterns found:

**1. Diátaxis — the 4 doc types** (https://diataxis.fr)
- Every doc is exactly ONE of: **tutorial** (teaches), **how-to** (gets a task
  done), **reference** (states facts, mirrors the machinery), **explanation**
  (why / context). Mixed-type pages are the #1 cause of unsearchable docs.
- The compass: *action vs cognition × acquisition vs application*. For our
  `docs/`: `overview/` ≈ explanation, `operations/` ≈ how-to, `backend/` +
  API/tabs reference sections ≈ reference.

**2. Google Markdown style guide** (https://google.github.io/styleguide/docguide/style.html)
- One H1 per page, matching the filename; intro 1–3 sentences; `## See also` at
  the bottom; ATX headings; blank line around headings; line-length wrap; no
  trailing whitespace; fenced code blocks with declared language; tables over
  prose for scannable data; descriptive link text; strongly prefer Markdown to
  HTML. "Better is better than best" — keep the bar realistic for a solo
  maintainer.

**3. Google Developer Documentation style guide** (voice rules that transfer)
- Second person, present tense, active voice, define acronyms on first use,
  concrete examples on every claim, short sentences, no apologizing.

**4. markdownlint** (https://github.com/DavidAnson/markdownlint)
- The de-facto machine-enforceable ruleset. Relevant rules: MD009 trailing
  spaces, MD012 multiple blanks, MD013 line length, MD014 `$` in code, MD022
  blanks around headings, MD024 duplicate headings, MD031 blanks around fences,
  MD032 blanks around lists, MD033 inline HTML, MD034 bare URLs, MD040 fenced
  code language, MD041 first line = H1. Community reference configs exist in
  skills repos (e.g. `pantheon-org/tekhne` markdown-authoring skill).

**5. Docs-as-code contribution guides** (https://docsio.co/blog/docs-as-code, https://www.mintlify.com/library/what-is-docs-as-code, GitScrum)
- A `CONTRIBUTING.md` inside `docs/` is the standard home for: file structure,
  naming conventions, style/tone rules, and the review process. The "no code
  change without its doc change in the same PR" rule is the strongest
  anti-rot pattern. Add linting only when the corpus is > ~20 pages.

**6. AGENTS.md / CLAUDE.md authoring advice** (applies to how the guide is written)
- Imperative rules, concrete paths/examples, no vague verbs ("be careful"),
  no repeating the README, rules have a lifecycle (prune stale ones).
- Our own AGENTS.md already has the routing rule: **code logic → `docs/`,
  agent behavior → AGENTS.md**. The new guide formalizes *how* `docs/` is
  written; AGENTS.md keeps *what* to learn.

---

## Current-state audit (2026-08-09)

```
docs/
├── README.md                 (44 lines)   index + layout + short "Adding new docs"
├── overview/  architecture (119), business-logic (451), react-migration (68)
├── backend/   services (255), middleware (50), user-management (294)
├── pages/     overview (299)
├── tabs/      overview (113), terminal (354), web (195), settings (85),
│              health (38), mcp (32), skills (30)
├── components/ stats (22), theme (97)
└── operations/ overview (113)
```
18 files, 2,659 lines.

**What's already consistent (good):**
- Exactly one H1 per file, `##`-style ATX headings.
- No YAML frontmatter anywhere (the `---` hits in user-management /
  business-logic are horizontal rules / ASCII art, not frontmatter).
- Fenced code blocks are widely used; `## See also` / related links exist in
  several files.

**Inconsistencies found:**
1. **No style rules anywhere.** README.md's "Adding new docs" says only *which
   folder*, nothing about format, voice, headings, links, or line length. This
   is the core gap — the parent doc.
2. **Stale content.** `operations/overview.md` §Settings describes only
   `{ allowDocker, network }`, but the Settings tab now also handles workspace
   mount, extra volumes, extra ports, SSH expose, custom SSH port + password.
   `overview/architecture.md` env table + container table predate the driver
   framework (only lists openclaw; no opencode/picoclaw/hermes/codex) and the
   `HOST_NAME`/`HOST_PROTO` overrides.
3. **Overlap / blurred boundaries.** `backend/services.md` already covers
   container-health, job-log, drivers, api-keys, vault; `overview/business-logic.md`
   re-narrates several of the same flows. `tabs/overview.md` vs
   `pages/overview.md` split is fuzzy (each page that is a tab also appears in
   both). Decide one owner per fact.
4. **Missing whole areas** (see Gap list below): no API reference, no doc for
   the webui's own `/mcp` server, no driver-framework doc, no Vault/API-keys
   page doc, no backup/restore doc, sparse components/.
5. **Formatting drift:** mixed table-pipe alignment, some long unwrapped lines
   (>100 chars), occasional `**bold**` where a heading fits, ASCII diagrams
   (fine — they're intentional), a few `---` HRs used inconsistently.

---

## Proposed conventions (what CONTRIBUTING.md will mandate)

### File placement & naming
- One topic per file. Filename = topic, `kebab-case.md`, no `guide-`, `doc-`
  prefixes. Keep the 6 existing folders; a page belongs to exactly one folder.
- `overview/` — whole-system *explanation* (architecture, business logic).
- `backend/` — *reference* for server modules (services, middleware, auth,
  security model). One file per service family, mirrors `src/services/`.
- `pages/` — one file per top-level page or a page overview.
- `tabs/` — one file per Agent-detail tab (frontend component + its API).
- `components/` — reusable UI pieces that aren't a page/tab.
- `operations/` — *how-to* runbooks (lifecycle, backup/restore, dev workflow,
  git, troubleshooting).
- **Reference vs explanation rule:** facts about how the code works → the
  backend/tabs/API file; the *why* and cross-cutting context → overview.
  Never narrate the same behavior in both — link instead.

### Page skeleton (every file)
```markdown
# <Page Title>                 ← one H1, matches the topic, not the filename verbatim
                                  (title case, no trailing period)

1–3 sentence intro: what this page covers and who it's for.

## <Major Section>             ← H2 (topic-ordered)
### <Subsection>               ← H3 (H4+ strongly discouraged; split the file)
...
## See Also                    ← bottom: relative links to adjacent docs
```

### Formatting rules (machine-checkable where possible)
- **Headings:** ATX only (`##`+). Exactly one H1. Blank line before and after
  every heading (MD022). No duplicate heading text within a file (MD024).
  Unique, descriptive heading names (anchors).
- **Line length:** wrap prose at **100 chars** (MD013: line_length 100,
  code_blocks/tables off — matches the corpus's current density; Google's 80 is
  too tight for this repo's prose).
- **Code blocks:** fenced with a language tag always (`bash`, `js`, `yaml`,
  `json`, `text`) — MD040. Bash snippets that are copy-paste commands get no
  `$` prompt unless output follows (MD014).
- **Inline code** for commands, paths, file names, env vars, tokens, keys.
- **Tables** for scannable reference data; prefer lists over tables for short
  content. Keep cells short (a cell that needs wrapping probably wants a link).
- **Links:** relative paths inside `docs/` (survive moves); absolute URLs
  externally; descriptive link text (never "click here"); no bare URLs (MD034).
- **Lists:** `- ` with a space; blank line before/after lists (MD032);
  lazy numbering (`1.` then `2.`) — markdown renders correctly anyway.
- **No trailing whitespace** (MD009); at most one blank line between blocks
  (MD012); no tabs (MD010).
- **Markdown, not HTML** — except ASCII diagrams where a code block is
  genuinely clearer (current corpus uses these well).
- **Voice:** present tense, active voice, second person for how-tos. Define
  acronyms (PAD, SSE, SSG) on first use. No "unfortunately", no filler.
- **Terminology:** PAD (not "vm"/"agent container"), the webui container is
  `paddock` (image `paddock-webui`), agents are `pad-*`. When a new term is
  introduced in a doc, add it to the Terminology section of CONTRIBUTING.md.

### Keeping docs fresh
- **Code change → doc change in the same change.** When a plan from `plans/`
  is absorbed, move it to `docs/` and rewrite it as documentation (drop
  planning language, keep what exists) — this rule is already in
  `docs/README.md`, the guide will restate it as the standard.
- Volatile docs carry a `> Last updated: YYYY-MM-DD` line under the intro.
- Quarterly sweep: re-read one folder, fix staleness, update the guide if a
  rule fought reality.

### The lint layer (optional but cheap)
- Add `.markdownlint.jsonc` at repo root (or `docs/`) with the config below.
  Run with `markdownlint-cli2 "docs/**/*.md"` (npx, no install needed) in the
  webui container or on host. Do NOT gate anything — lint output is a
  checklist for the audit, not a CI gate yet (corpus < 20 pages, solo
  maintainer). Vale prose linting stays out of scope for now.

```jsonc
{
  "MD013": { "line_length": 100, "code_blocks": false, "tables": false },
  "MD024": { "siblings_only": true },
  "MD033": { "allowed_elements": ["br"] },
  "MD041": true
}
```

---

## Parent doc: `docs/STYLE-GUIDE.md` (phase 1 — DONE)

Created 2026-08-09. **Named `STYLE-GUIDE.md`, not `CONTRIBUTING.md`** — user
decision: a CONTRIBUTING file is about "how to contribute / what contributing
is"; this file is pure formatting + voice rules, so the style-guide name is the
honest one. It contains:

1. **Purpose & scope** — this file is the authority; the corpus must match it.
2. **Folder map** — the 6 folders + where a given piece of content goes
   (fold in the current README "Adding new docs" guidance and expand it).
3. **Page skeleton** — the template above, with a filled-in example.
4. **Formatting rules** — the rules above, each with a 1-line "why".
5. **Voice & terminology** — writing rules + the project glossary.
6. **The plan→docs lifecycle** — absorbing `plans/*.md`, code-change rule.
7. **Review checklist** — the self-check list before a doc is "done".

Also update `docs/README.md`: link the style guide at the top, keep the layout
tree, drop the duplicated "Adding new docs" text (point at the guide).
**DONE 2026-08-09** — README now indexes `STYLE-GUIDE.md` and points at it.

---

## Review pass over existing docs (phase 2 tasks)

Formatting-only fixes (mechanical):
- [ ] Run markdownlint (`npx markdownlint-cli2 "docs/**/*.md"`) → collect the
      baseline list; fix every violation per the config above.
- [ ] Add the `## See Also` section to files missing it (cross-link each tab
      ↔ pages ↔ backend).
- [ ] Unify table formatting; wrap lines > 100; remove stray `---` HRs where a
      section heading is clearer.
- [ ] Confirm one H1 + intro sentence in every file (18/18 already have H1).

Staleness/accuracy fixes (content):
- [ ] `operations/overview.md` §Settings → expand to the full current option
      set (docker, network, workspace mount, extra volumes, extra ports, SSH
      expose, custom SSH container port + password); link to `tabs/settings.md`
      and the web-publish doc.
- [ ] `overview/architecture.md` → update container/env tables for the driver
      framework (5 agent types), `HOST_NAME`/`HOST_PROTO`, and the socat door.
- [ ] Dedupe: decide which of `backend/services.md` vs
      `overview/business-logic.md` owns each flow; convert the loser to a
      pointer with a 2-sentence summary. Same for `tabs/overview.md` vs
      `pages/overview.md`.
- [ ] Sweep every file for `/api/*` route and function names that have drifted
      (spot-check against `src/app.js` / `src/services/`).

---

## Gap analysis — new docs to add (phase 3, priority order)

High (missing whole areas):
- [ ] **API reference** (`backend/api.md` or `reference/api.md`) — every
      `/api/agents/:name/*` + `/api/config` + `/api/session` + `/api/vault*`
      route: method, body, response, SSE event shapes. Diátaxis *reference*:
      dry facts, mirror `src/app.js`.
- [ ] **The webui's own MCP server** (`backend/mcp.md`) — the 12 `/mcp` tools
      (unprefixed names, shared-service rule), auth, testing. Distinct from
      `tabs/mcp.md` which covers the *agent's* MCP servers.
- [ ] **Driver framework** (`backend/drivers.md`) — the 5 drivers
      (openclaw/opencode/picoclaw/hermes/codex), `getDriver()` fallback, per-
      driver configFormat/configFile/dataDir/workspaceDir, the require()-cache
      restart gotcha.
- [ ] **Vault + API keys** (`backend/vault.md` or pages doc) — AES-256-GCM
      store, `/vault` page, API-key create/show-once/hash.
- [ ] **Backup & restore** (`operations/backup.md`) — backup-manager flow,
      `manage_backups.sh`, clone, restore ordering, external-workspace
      exclusion.
- [ ] **SSH expose** (`operations/ssh.md` or fold into `tabs/web.md`) — host
      port + container port + password, door forwarding, start.sh sed block,
      image rebuild for non-22 ports.

Medium:
- [ ] **Component docs** — HealthCheckModal, ContainerInfoModal, CommandsPane,
      prompt modal, FileViewer (`components/` currently has only stats + theme).
- [ ] **Security model** (`backend/security.md`) — auth/CSRF (partially in
      middleware.md), owner scoping (user-management.md), secret redaction,
      guard system, vault key handling. Possibly just cross-link the three.
- [ ] **State & client structure** (`overview/react-migration.md` or a new
      `frontend.md`) — Zustand stores, lib modules, routing.
- [ ] **Terminal deep-dive** already exists (`tabs/terminal.md`, 354 lines) —
      verify it covers the bash-shell fix + Ctrl+C notes.

Low / decide later:
- [ ] Create-Agent flow walkthrough; login page; web-publish troubleshooting
      runbook.

---

## Process rules going forward

- **The guide is the contract.** New docs must conform; edits to old docs must
  bring them closer to the guide (no "while I'm here, whatever" edits).
- **One owner of each fact.** If two files must mention the same behavior, one
  is the source and the other links.
- **Learnings route** (already in AGENTS.md) stays: code logic → `docs/`,
  agent behavior → AGENTS.md. The guide adds the *format* half.
- When this plan is absorbed, delete `plans/31-docs-organization.md`.

---

## Open questions (decide before phase 1)

1. **Parent filename** — `docs/CONTRIBUTING.md` (docs-as-code convention,
   recommended) vs `docs/STYLE-GUIDE.md` vs `docs/GUIDE.md`?
   **DECIDED 2026-08-09: `STYLE-GUIDE.md`** — the file is formatting rules, not
   a contribution process, so the style-guide name is accurate. (If a real
   contribution-process doc is ever wanted, it can point at the style guide.)
2. **Lint tooling now or later** — commit `.markdownlint.jsonc` + run it in the
   audit (recommended), or keep rules prose-only for now?
3. **Line length** — 100 (recommended, matches corpus) or strict 80?
4. **Phase 3 scope** — all high-priority new docs in one go, or just the API
   reference + MCP + drivers first?
5. **API reference format** — a single `backend/api.md` table dump, or one
   `reference/api/*.md` per route group?
