# Paddock Documentation Style Guide

This file is the single authority for how documentation in `docs/` is written,
structured, and kept fresh. If a document disagrees with this guide, fix the
document — not the guide.

It applies to every Markdown file under `docs/`. The `README.md` is the index
and map; this file is the rulebook. `AGENTS.md` decides *what* to learn and
where (code logic → `docs/`, agent behavior → `AGENTS.md`); this guide decides
*how* `docs/` is written.

## Folder map

Every document lives in exactly one folder and serves one purpose.

| Folder | Kind | Holds | Example |
|--------|------|-------|---------|
| `overview/` | explanation | whole-system context: architecture, business logic, migration notes | `architecture.md` |
| `backend/` | reference | server modules: services, middleware, auth, security model | `services.md` |
| `pages/` | reference | top-level pages (one file per page, or an overview) | `overview.md` |
| `tabs/` | reference | one file per Agent-detail tab: frontend component + its API | `settings.md` |
| `components/` | reference | reusable UI pieces that aren't a full page or tab | `theme.md` |
| `operations/` | how-to | runbooks: lifecycle, backup/restore, dev workflow, git | `overview.md` |

Rules:

- **One topic per file.** If a file needs more than a few H2s, split it.
- **Facts about how the code works** (functions, routes, schemas) go in the
  reference folders (`backend/`, `tabs/`, `pages/`, `components/`). The *why*
  and the cross-cutting picture go in `overview/`. Never narrate the same
  behavior in both — write it once, link from the other.
- **Name files by topic, not by type**: `api.md`, not `api-guide-v2.md`.
  Kebab-case, no prefixes.
- **Diátaxis rule**: a page is one thing. Facts that state ("what is") and
  steps that instruct ("how to") don't mix on the same page — put the steps in
  `operations/` or the tab doc and link.

## Page skeleton

Every file follows the same shape:

```markdown
# Page Title

One to three sentence intro: what this page covers and who it's for. New
readers land here first, so assume they know nothing.

## Major Section

### Subsection

## See Also
```

- **One H1** per file, title case, no trailing period. It is the page title.
- **H2** for major sections, **H3** for subsections. H4+ means the page is too
  deep — split the file instead.
- **Blank line before and after every heading.**
- **Intro paragraph** directly under the H1, before the first H2.
- **`## See Also`** at the bottom with relative links to adjacent docs.
- Volatile pages carry a `> Last updated: YYYY-MM-DD` line under the intro.
  Add or bump it whenever the content changes; remove it when the page settles.

## Formatting rules

Each rule has a one-line "why" so a future author can judge exceptions.

### Headings

- ATX style only (`##`, `###`). Never `#`-with-underscore (setext), never
  closed ATX (`## title ##`).
- Unique, descriptive heading names — they become anchor links. Don't repeat a
  heading text within a file.
- Why: consistent anchors, markdownlint-friendly, renders everywhere.

### Line length

- Wrap prose at **100 characters**. Code blocks and table cells are exempt.
- Why: readable diffs, no accidental horizontal scroll; the corpus already
  wraps around this density.

### Code

- **Fenced code blocks** with a language tag, always: `bash`, `js`, `yaml`,
  `json`, `text`. Never indented code blocks.
- **No `$` prompt** in bash snippets unless the command's output follows.
- **Inline code** (backticks) for commands, paths, file names, env vars,
  tokens, and keys.
- Why: syntax highlighting, copy-pasteable commands, literal rendering of
  things that would otherwise be mangled by Markdown.

### Tables

- Tables for scannable reference data; lists for short content.
- Keep cells short. A cell that needs wrapping probably wants a link or a
  split. Pipe alignment is optional; keep it tidy.
- Why: tables are the fastest way to scan a column of facts; long cells break
  that.

### Links

- Relative paths inside `docs/`: `[settings tab](tabs/settings.md)`. They
  survive moves and URL changes.
- Absolute URLs externally: `[Diátaxis](https://diataxis.fr/)`.
- Descriptive link text, never "click here".
- No bare URLs — always wrap in link syntax.
- Why: dead links destroy trust; descriptive text is scannable and
  screen-reader friendly.

### Lists and whitespace

- Bullets: `- ` with a space. Blank line before and after every list.
- Numbered lists: lazy numbering (`1.`, `2.`) — Markdown renders it correctly.
- No trailing whitespace. At most one blank line between blocks. No tabs.
- Why: lint-clean, stable diffs.

### Markdown, not HTML

- Prefer plain Markdown. HTML `<details>`, `&lt;kbd&gt;`, or `<br>` only when
  Markdown genuinely can't do the job.
- ASCII diagrams inside `text` code blocks are fine and welcome — the corpus
  uses them well (user-management, terminal).

## Voice

- **Present tense, active voice**: "The API returns a 200." Not "The API will
  return a 200."
- **Second person for how-tos**: "You expose SSH from the Settings tab." Not
  "The user exposes" or "SSH is exposed."
- **Be concrete**: every claim gets an example, a path, or a command.
- **Define acronyms on first use** (PAD, SSE, SSG).
- **No filler**: no "unfortunately", no apology, no "as mentioned above".
- Why: reference docs are scanned, not read; the rules keep them short and
  unambiguous.

## Terminology

Use the project's actual names. When you introduce a new term in a doc, add it
here.

| Term | Means |
|------|-------|
| PAD | one agent instance; dir `instances/&lt;name&gt;/`, container `pad-*` |
| paddock | the webui container (image `paddock-webui`, Express on 6789) |
| agent / bot | the program a PAD runs (openclaw, opencode, picoclaw, hermes, codex, claude) |
| driver | per-type adapter in `src/services/drivers/`; `getDriver()` falls back to openclaw |
| socat door | `&lt;name&gt;-door` container that carries host ports for peer-networked agents |
| peer | a container an agent routes through via `network_mode: container:` |
| Vault | encrypted key-value store (`src/services/vault.js`, AES-256-GCM) |
| webui | the paddock web app (React SPA + Express API) |

## Lifecycle: keeping docs fresh

- **A code change ships with its doc change.** When a behavior, route, or
  service changes, update the matching doc in the same change. This is the
  strongest anti-rot rule this project has.
- **Absorbing a plan.** When a plan from `plans/` is implemented, move it to
  the matching `docs/` folder and rewrite it as documentation — drop planning
  language ("next steps", "open questions"), keep what exists, re-shape it to
  this guide's skeleton.
- **Learnings route** (from `AGENTS.md`): code logic and the reason code is
  there → `docs/`; agent behavior and workflow → `AGENTS.md`.
- **Quarterly sweep.** Re-read one folder, fix staleness, and update this guide
  only if a rule fought reality. An outdated doc is worse than none.

## Review checklist

A document is done when all of these hold:

- [ ] One H1, title case, intro paragraph under it
- [ ] Lives in the right folder for its kind (reference vs explanation vs how-to)
- [ ] No behavior duplicated from another file — links instead
- [ ] Prose wrapped at 100 chars, no trailing whitespace
- [ ] Every code block fenced with a language tag
- [ ] Commands, paths, and env vars in inline code
- [ ] Links relative inside `docs/`, descriptive text, none bare
- [ ] Acronyms defined on first use, terminology matches the glossary
- [ ] `## See Also` links adjacent docs
- [ ] `> Last updated:` bumped if the content is volatile

## Linting (optional companion)

`markdownlint-cli2` machine-checks most of the rules above. Suggested config
(repo root, `.markdownlint.jsonc`):

```jsonc
{
  "MD013": { "line_length": 100, "code_blocks": false, "tables": false },
  "MD024": { "siblings_only": true },
  "MD033": { "allowed_elements": ["br"] },
  "MD041": true
}
```

Run: `npx markdownlint-cli2 "docs/**/*.md"`. Output is a checklist for reviews,
not a CI gate — the corpus is small and the maintainer is one person. Add Vale
for prose linting only if the corpus grows past ~20 pages.
