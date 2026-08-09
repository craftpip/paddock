# Plan 37a — Commands Tab Audit · Subtask: OpenClaw

## Status: Complete (2026-08-09) — audited against installed CLI + user review; no changes needed.

> Sub-file of `plans/37-commands-button-audit.md`. This file holds the
> OpenClaw-specific audit; the sibling `37b`–`37f` files cover the other agent
> types. Read the main plan first.

## Scope

Audit the Commands tab surface for openclaw against the essential groups
(Providers, Channels, MCP, Skills) + openclaw's own features (memory, doctor,
security, vault). Openclaw is the reference implementation — the other five
types are measured against it.

## How openclaw renders commands (exception to the rule)

- Renders **5 hardcoded flows** in the CommandsPane (`CommandsPane.jsx`):
  `MessagingFlow`, `ModelsFlow`, `McpFlow`, `SkillsFlow`, `MemoryFlow` — all
  form-capable via `usePrompt()`.
- **PLUS** driver groups from `src/services/drivers/openclaw.js`: Config
  (validate, file), Security (audit/audit deep/fix), Doctor (lint/deep/
  compact, security doctor variants), Diagnostics (status, gateway status).
- **PLUS** the Vault dropdown (server-side secrets, PIN-gated).
- Data (servers, skills, backups) shows as compact chips in the flow.

## Essential-groups coverage (all ✅)

| Group    | add                  | list                 | remove               | update                     |
|----------|----------------------|----------------------|----------------------|----------------------------|
| Providers| Add provider         | List added providers | Remove provider      | Set default model          |
| Channels | Add/Remove channel   | List added channels  | (same Add/Remove)    | Check status/logs          |
| MCP      | Add server (form)    | List servers         | Remove server (form) | Reload / probe / doctor    |
| Skills   | Install (form box)   | List installed       | ➖ config-based       | Check / Search / Update all|
| Memory   | —                    | Status/Deep status   | —                    | Index / Reindex / Promote  |

## Findings / gaps

- **No gaps.** All four essential groups fully covered with add/list/remove/
  update; memory, security, doctor and vault go beyond the four groups.
- The hardcoded flows are openclaw-only and already use the exact form pattern
  that plan 37 generalized to driver groups (`fields` + prompt modal).
- openclaw CLI version confirmed in `pad-openclaw-work-pls` at audit time.

## Checklist

- [x] Survey openclaw CommandsPane flows (Messaging/Models/MCP/Skills/Memory)
- [x] Survey driver groups (Config/Security/Doctor/Diagnostics) + Vault
- [x] Map against essential groups (Providers/Channels/MCP/Skills)
- [x] Confirm no missing/duplicate/broken buttons (user-reviewed)
