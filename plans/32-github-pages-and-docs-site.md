# Goal 32 — GitHub Pages: modern deploy workflow + docs website from `docs/`

> **Status: Plan / not yet started.** User request: "create the modern workflow,
> keep it" for GitHub Pages, plus a documentation website built directly from the
> existing `docs/` markdown folder so anyone can read the tool's docs on the web.
>
> Repo facts (2026-08-09): default branch is `master`. No `.github/` yet. `docs/`
> is 18 plain markdown files in 6 subfolders, no YAML frontmatter anywhere
> (verified — no file starts with `---`). SPA is `src/client` (React 19 + Vite 6,
> `base: '/'`, `outDir: '../public'` for the Express backend). Host node is
> v20.20.2 — same as the webui container.

## Goal

1. **One modern GitHub Actions Pages workflow** that builds the React SPA + the
   VitePress docs site, merges them into one Pages artifact, and deploys via
   `actions/deploy-pages` — **no `gh-pages` branch to manage, no manual commits**.
   GitHub Pages serves **one site per repo**, so app and docs share the repo URL:
   - App at `https://<user>.github.io/<repo>/`
   - Docs at `https://<user>.github.io/<repo>/docs/`
2. **Docs site generator: VitePress.** It reads a markdown folder (`docs/`)
   directly into pages with a sidebar/nav — the closest thing to "just convert
   the docs folder into a website" with zero content rewriting.

## Toolchain decision — why VitePress

- Source root is already `docs/` — VitePress's native convention. Each `*.md`
  becomes a page; folder structure maps to URLs (`docs/tabs/web.md` →
  `/docs/tabs/web`). `docs/README.md` → the docs index page.
- No frontmatter required — our docs have none, so they build as-is.
- A single `docs/.vitepress/config.mjs` + one `docs/package.json` adds the whole
  site. No new top-level build system.
- VitePress `base` is configurable, so it nests under `/docs/` of the Pages URL.

Alternatives rejected: Docusaurus (React, but needs a full site skeleton + code
duplication, heavier), MkDocs (Python, foreign stack), plain HTML generation
(build a generator from scratch — VitePress already exists).

## Key mechanics

### Subpath base is repo-name-driven

Pages hosts at `https://<user>.github.io/<repo>/`. The repo name isn't known at
authoring time, so **both builds take their base from env vars** the workflow
sets (falls back to `/` locally / for the Express build):

- SPA: `vite build --base=$APP_BASE --outDir=...` where
  `APP_BASE=/<repo>/`.
- Docs: VitePress `base: process.env.DOCS_BASE || '/docs/'` where
  `DOCS_BASE=/<repo>/docs/`.

The **Express build must stay unchanged** (`base '/'`, outDir `../public`) — the
Pages build overrides flags on the CLI only, never in `vite.config.js`.

### SPA router must respect the subpath

`App.jsx` uses `<BrowserRouter>` with no `basename`. Under `/<repo>/` all routes
would resolve wrong. Fix: `basename={import.meta.env.BASE_URL}` — Vite injects
`BASE_URL` from the `base` flag, so it's `/` in dev/Express and `/<repo>/` on
Pages. One-line change, zero behavior change locally.

### `404.html` for SPA deep links

GitHub Pages has no catch-all rewrite. A refresh on `/repo/agents/<id>/settings`
404s unless `index.html` is also served as `404.html` (GitHub Pages serves
`404.html` for unmatched paths; the router then takes over). Copy
`index.html` → `404.html` in the artifact.

### Artifact layout (one dist, two apps)

```
dist/
├── index.html          ← SPA
├── 404.html            ← copy of index.html (SPA fallback)
├── .nojekyll           ← tell Pages not to treat underscore dirs specially
└── docs/               ← VitePress output (base /docs/, own assets)
```

Build order in CI: SPA → `dist/` (staging), VitePress → `dist/docs`, then copy
`404.html` + write `.nojekyll`.

## Implementation phases

### Phase 1 — VitePress docs site (local, testable without GitHub)

- [ ] `docs/package.json` — `{ "type": "module" }`, devDependency `vitepress`
      (`^1`), scripts `"docs:dev": "vitepress dev"`, `"docs:build":
      "vitepress build"`. This is VitePress's expected home so `npm ci` +
      `npm run docs:build` inside `docs/` is self-contained.
- [ ] `docs/.vitepress/config.mjs`:
  - `title` from docs README subject (e.g. "PAD Friends Docs"), `description`.
  - `base: process.env.DOCS_BASE || '/docs/'` (so local preview + Pages both
    work; trailing-slash-safe for `<repo>/docs`).
  - `outDir` left at VitePress default (`docs/.vitepress/dist`); the workflow
    moves it into the app's `dist/docs/`.
  - `themeConfig.nav` (top bar): Dashboard `/`, Docs `/docs/`, GitHub repo link.
  - `themeConfig.sidebar` mirroring the folder tree — sections: Overview
    (architecture, business-logic, react-migration), Backend (services,
    middleware, user-management), Pages, Tabs (overview, terminal, web, health,
    mcp, skills, settings), Components (stats, theme), Operations. Links use
    VitePress paths (`/tabs/web`) so they're subpath-safe.
  - `lastUpdated` true (git-based dates; harmless).
- [ ] `.gitignore` additions: `docs/.vitepress/dist` + `.cache` (VitePress
      cache). `**/node_modules/` already covers `docs/node_modules`.
- [ ] **Verify locally on the host:** `cd docs && npm install && npm run
      docs:build`, then serve `docs/.vitepress/dist` and check pages render,
      sidebar works, relative links resolve, no 404s in the generated HTML.

### Phase 2 — SPA subpath fixes

- [ ] `src/client/src/App.jsx`: `<BrowserRouter basename={import.meta.env.BASE_URL}>`.
- [ ] Rebuild + restart webui; confirm dev (`/`) routing still works and the
      Express build is byte-identical in behavior (`npm run build` unchanged
      since no config touched).
- [ ] Verify a Pages-style build locally: `vite build --base=/demo/ --outDir
      ../../dist`, confirm assets are under `/demo/assets/...`.

### Phase 3 — the modern workflow

- [ ] `.github/workflows/pages.yml` (new):
  - Trigger: `on: push` to `master` (and `workflow_dispatch` for manual runs).
  - `permissions: { contents: read, pages: write, id-token: write }`,
    `concurrency: { group: pages, cancel-in-progress: true }`.
  - Build job: checkout → setup-node 20 → build SPA with
    `APP_BASE=/${{ github.event.repository.name }}/` and `--outDir ../../dist`
    (from `src/client`, lands at repo `dist/`) → build docs with
    `DOCS_BASE=/${{ github.event.repository.name }}/docs/`, copy
    `.vitepress/dist/*` into `dist/docs/` → `cp dist/index.html dist/404.html`
    → `touch dist/.nojekyll`.
  - `actions/upload-pages-artifact@v3` with `path: dist`.
  - Deploy job: `needs: build`, `environment: github-pages`, step
    `actions/deploy-pages@v4`. That's the whole modern flow — the artifact is
    the contract, no branch.
  - Docs CI deps: `npm ci` in both `src/client` (existing lockfile) and
    `docs/` (new lockfile generated in Phase 1).
- [ ] Optional hardening (later): `actions/configure-pages`; previews on PR via
      `pull_request` trigger if wanted.

### Phase 4 — GitHub setup + verification

- [ ] After the user creates the repo and pushes `master`: in repo Settings →
      Pages, set **Source = GitHub Actions** (must be clicked once; the workflow
      can't enable it itself).
- [ ] Verify live: root loads the app (API calls will 404 — see "Known
      limitation"), `/docs/` loads the docs site, deep links + sidebar + assets
      all resolve, `404.html` works on refresh of a nested app route.

## Known limitation — the app shell is static on Pages

This is a Docker-management dashboard; `/api/*` and `/ws/*` need the Express
backend, which doesn't exist on GitHub Pages. The deployed app is a **static UI
demo only** (login screen, layout, routes render; data calls fail). The docs
site is the real content and works fully. Note this on the docs landing page /
Dashboard so visitors aren't surprised. The live tool keeps being served from
`10.69.1.164:6789` as before.

## Files touched

| File | Change |
|------|--------|
| `docs/package.json` | new — vitepress dep + scripts |
| `docs/package-lock.json` | new — generated |
| `docs/.vitepress/config.mjs` | new — site config, base, nav, sidebar |
| `.gitignore` | add `docs/.vitepress/dist`, `.cache` |
| `src/client/src/App.jsx` | one line — `BrowserRouter basename` |
| `.github/workflows/pages.yml` | new — build + deploy |
| `plans/32-github-pages-and-docs-site.md` | delete after absorption |

## Open questions

1. **App shell on Pages** — deploy the (static, API-less) SPA demo, or skip the
   app and deploy **docs only** at the root? Default: include both (user said
   "keep" the app workflow). Docs URL is `/docs/` either way.
2. **VitePress version** — pin `vitepress@^1` (stable) vs `latest`.
3. **Nav link to the live tool** — add "Live dashboard → 10.69.1.164:6789" link
   in the docs nav for anyone who wants the real thing?

## Process note

When absorbed: delete this plan file, record learnings in AGENTS.md (the
VitePress setup, the subpath-base trick, the `404.html` requirement, the
"GitHub Actions" source click), and add a `docs/operations/overview.md` note or
new `docs/operations/publishing.md` runbook per the plan→docs lifecycle rule.
