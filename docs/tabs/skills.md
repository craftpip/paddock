# Skills Tab

Lists installed skills for an agent split into **User Skills** (installed from ClawHub, Git, or local) and **Bundled Skills** (shipped with OpenClaw).

## Features

- **Skill cards** — name, version badge, source label (Bundled/User), eligible indicator, description
- **Skill info modal** — click Info to see full details: description, source, eligible flag, missing bins, requirements, file path
- **Install** — + Install button opens form with:
  - Source radio: ClawHub / Git / Local
  - Ref input (@owner/slug, owner/repo, or ./path)
  - Custom name (--as) and Force toggle
- **Verify** — runs `openclaw skills verify --json`, shows publisher/verified status
- **Update** — updates a single skill
- **Remove** — deletes the skill directory from workspace/skills/

## API Endpoints (app.js)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/agents/:name/skills` | List skills + check (30s cache) |
| GET | `/api/agents/:name/skills/info?name=<slug>` | Full skill info |
| POST | `/api/agents/:name/skills/install` | Install from ClawHub/Git/local |
| POST | `/api/agents/:name/skills/remove` | Remove by deleting directory |
| POST | `/api/agents/:name/skills/update` | Update single or all skills |
| POST | `/api/agents/:name/skills/verify` | Verify ClawHub skill |

## Components

File: `src/client/src/pages/AgentDetail.jsx` — `SkillsTab` (lines 1515-1622), `SkillCard` (lines 1624-1649), `InstallForm` (lines 1651-1701).
