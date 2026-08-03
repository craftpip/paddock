# Task: Create Architecture Documentation

## Goal
Write `docs/architecture.md` — the single source of truth for VM Friends project business logic, structure, and behavior.

## Plan

1. Read all source files to understand the full system
   - [x] AGENTS.md (585 lines of context)
   - [x] `src/app.js` (Express server, legacy routes, WS terminal)
   - [x] `src/routes/agents.js` (All /agents/* routes)
   - [x] `src/services/agent-registry.js` (Agent discovery)
   - [x] `src/services/vm-manager.js` (Create/remove/reset VMs)
   - [x] `src/services/backup-manager.js` (Backup/restore)
   - [x] `src/services/workspace.js` (File operations)
   - [x] `src/services/db.js` (SQLite schema)
   - [x] `src/middleware/auth.js` (Session auth, CSRF)
    - [x] `src/middleware/rateLimit.js` (Rate limiting)
    - [x] All 12 EJS view templates + 7 partials
   - [x] `docker-compose.yml` + `docker-compose.override.yml`
   - [x] `src/package.json` + `src/Dockerfile`
   - [x] `src/test/services.test.js`

2. Write `docs/architecture.md` covering:
   - [x] Project Overview & System Architecture
   - [x] Directory Structure
   - [x] Docker Infrastructure (agent types, compose)
   - [x] WebUI Application (Express, middleware, routing)
   - [x] Agent Discovery & Registry
   - [x] VM/Agent Lifecycle (create, clone, start, stop, restart, remove, reset)
   - [x] Backup System
   - [x] Workspace Service & Path Safety
   - [x] Vault (encrypted secrets)
   - [x] Web UI Pages (all pages, tabs, HTMX interactions)
   - [x] WebSocket Terminal
   - [x] SQLite Data Model
   - [x] Authentication & Security
   - [x] Onboarding Flow
   - [x] Models & Providers Configuration

3. Write `docs/architecture.md` covering:
   - [x] Project Overview & System Architecture
   - [x] Directory Structure
   - [x] Docker Infrastructure (agent types, compose)
   - [x] WebUI Application (Express, middleware, routing)
   - [x] Agent Discovery & Registry
   - [x] VM/Agent Lifecycle (create, clone, start, stop, restart, remove, reset)
   - [x] Backup System
   - [x] Workspace Service & Path Safety
   - [x] Vault (encrypted secrets)
   - [x] Web UI Pages (all pages, tabs, HTMX interactions)
   - [x] WebSocket Terminal
   - [x] SQLite Data Model
   - [x] Authentication & Security
   - [x] Onboarding Flow
   - [x] Models & Providers Configuration
   - [x] Config Save/Restore Safety
   - [x] Activity Audit System
   - [x] Testing
   - [x] Agent Configuration Model
   - [x] Error Handling
   - [x] Legacy Routes
   - [x] Key Business Rules Summary

3. Verify completeness and accuracy — **Done**
