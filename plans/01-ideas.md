# Ideas

## Status: Notes (2026-08-02) — idea index, no build items tracked here. The
one tracked idea (06 — Paddock's own MCP server) is unbuilt; it is the deferred
Phase 4 of plan 09.

See [10-terminal.md](10-terminal.md) for the core UI concept and rules.

## Paddock's own MCP (2026-08-02)

- [06-paddock-own-mcp.md](06-paddock-own-mcp.md) — paddock webui exposes its own MCP server (fleet management via MCP).

## Container user UID/GID option + create preview (2026-08-10)

Idea (unbuilt, no plan file yet): give the create form a "Container user"
choice — root (0) or local user (1000) — with GID always set, and show a live
compose/container preview in the create form.

- Backend: `createVm` accepts `uid`; persist `USER`/`GID` in `meta.env`; the
  generated compose emits `user: "<uid>:<gid>"` for non-root.
- Frontend: "Optional settings → Container options" segmented control (Root /
  Local user 1000), plus a live preview card showing the resulting service
  (image, container_name, user, ports, volumes, env).
- **Blocker found (2026-08-10):** every driver's `start.sh` requires root —
  `chpasswd`, `sed /etc/ssh/sshd_config`, sshd binding port 22, and config
  under `/root/.openclaw` etc. A whole-container `user: 1000:1000` will NOT
  boot on openclaw/opencode/codex/claude/picoclaw. Two paths:
  1. Simple `user:` option — offer root/local as-is; user picks root for
     agents that need it.
  2. Full non-root support — rework each driver image (data dirs → `/home/<user>`,
     non-privileged sshd) so the agent daemon really runs as uid 1000.
  Unresolved — ask the user which path when picked up.
