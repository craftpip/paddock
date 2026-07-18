# Self-Hosted Agent Management System Plan

## 1. Objective

Build a professional self-hosted agent management system on top of the current project.

The finished product should let an operator:

- create agents from the browser
- view all agents in one fleet dashboard
- inspect each agent through a clean detail view
- open a browser terminal into the agent runtime
- browse files inside the agent workspace
- upload files into the agent workspace safely
- download, preview, rename, move, and delete files safely
- inspect session history, recent activity, and runtime health
- manage credentials, models, backups, and maintenance centrally
- run the whole system self-hosted without depending on a paid hosted control plane

This plan is meant to be implementation-grade. It should be sufficient for another agent to build from without needing to rediscover the product shape.

## 2. Product Positioning

### 2.1 What This Product Is

- a self-hosted control plane for AI agents
- an admin dashboard for creating, operating, and maintaining agents
- a workspace-centric interface where files and sessions are first-class concepts
- a practical operations tool, not just a UI wrapper around shell scripts

### 2.2 What This Product Is Not

- not only a VM control panel
- not only a Docker viewer
- not just a log viewer with a terminal attached
- not an enterprise SaaS clone with unnecessary policy layers before core usability exists

### 2.3 Design Principle

The UI should speak in terms of `agents`, `workspaces`, `sessions`, and `activity`.
The infrastructure layer may still use VMs, containers, and bind mounts underneath, but that should not dominate the operator experience.

## 3. Current State Audit

### 3.1 Existing Strengths in This Repo

- Node.js/Express web app already exists
- browser terminal already works
- VM lifecycle exists: create, start, stop, restart, remove, reset
- credential storage exists
- onboarding flow exists
- backups exist
- usage reporting exists
- Docker-backed runtime model already exists

### 3.2 Current Product Gaps

- UI is VM-centric instead of agent-centric
- no agent registry abstraction
- no first-class workspace or file browser
- no upload/download workflow for workspace files
- no session history or structured activity history
- no production auth model beyond a single shared password gate
- raw config and raw meta are exposed too directly
- no audit trail for destructive actions
- no role separation
- no formal API model for future frontend expansion

### 3.3 Current Technical Constraints

- runtime state is derived from filesystem + Docker, not from a central app database
- metadata is currently thin and partly inferred from `meta.env`
- file ownership in some project paths is root-owned due to Docker behavior
- nested instance directories can have permission barriers from the host side
- app is currently monolithic, route-heavy, and not yet split into domain services

## 4. Product Vision

The product should feel like a self-hosted version of hosted agent platforms and control dashboards:

- agent fleet dashboard
- per-agent overview and status
- workspace explorer and file actions
- browser terminal
- session and activity timeline
- usage, cost, and runtime visibility
- credentials and model/provider management
- maintenance and backups

Good external patterns to borrow:

- self-hosted dashboards such as Hermes Control Interface: files, sessions, logs, agents, maintenance
- workspace abstractions such as OpenHands: unified execution and file operations model
- hosted control planes such as CrewAI: observability, governance, lifecycle discipline

The implementation should borrow the shape of those products, not their marketing bloat.

## 5. Core Product Entities

### 5.1 Agent

Represents the operator-facing managed unit.

Required fields:

- `id`
- `name`
- `display_name`
- `agent_type`
- `runtime_type`
- `runtime_ref`
- `status`
- `workspace_root`
- `config_root`
- `credential_refs`
- `default_model`
- `default_provider`
- `created_at`
- `updated_at`
- `last_activity_at`
- `health_summary`
- `tags`

### 5.2 Workspace

Represents the file system surface visible to the operator.

Required concepts:

- root path
- relative path browsing only
- tree view
- previewable files
- upload targets
- file metadata
- last modified time
- size
- content type

### 5.3 Session

Represents one interactive or autonomous run context.

Required fields:

- `id`
- `agent_id`
- `kind` such as direct, cron, onboarding, telegram, task
- `status`
- `started_at`
- `ended_at`
- `summary`
- `model`
- `provider`
- `tokens_in`
- `tokens_out`
- `cost_estimate`
- `source`

### 5.4 Activity Event

Represents auditable system and agent actions.

Required fields:

- `id`
- `agent_id`
- `category`
- `action`
- `actor`
- `status`
- `timestamp`
- `details`
- `resource_ref`

### 5.5 Credential

Represents a reusable secret or secret reference.

Required fields:

- `id`
- `name`
- `kind`
- `provider`
- `secret_ref`
- `created_at`
- `updated_at`
- `last_used_at`
- `scope`

## 6. Production Goals

### 6.1 Functional Goals

- create and manage agents from browser
- browse and manage workspace files
- upload files safely
- inspect sessions and logs
- operate runtimes safely
- manage credentials centrally
- provide backups and restore workflows

### 6.2 Non-Functional Goals

- secure by default for file and terminal surfaces
- predictable route and API model
- resilient against path traversal and config leakage
- understandable by a single admin operator first
- extensible toward multi-user later
- fast enough for local/self-hosted use on modest hardware

### 6.3 Production Readiness Goals

- explicit auth story
- explicit audit story
- explicit backup story
- explicit error handling and user feedback
- explicit logging and monitoring for the control plane itself
- clear rollout plan and migration path from existing VM UI

## 7. Information Architecture

### 7.1 Primary Navigation

- Agents
- Workspaces
- Sessions
- Usage
- Backups
- Credentials
- Settings

### 7.2 Agent Detail Navigation

- Overview
- Workspace
- Terminal
- Sessions
- Activity
- Logs
- Config
- Backups

### 7.3 Secondary Views

- create agent
- credential manager
- maintenance tools
- system diagnostics
- runtime usage analytics

## 8. User Roles

Even if full RBAC is not implemented in v1, the plan must assume these roles.

### 8.1 Admin

- full agent lifecycle control
- full file operations
- credential management
- backups and restore
- settings and system diagnostics

### 8.2 Operator

- can view agents
- can use terminal if allowed
- can browse files and upload files if allowed
- can start/stop/restart but not remove/restore unless explicitly granted

### 8.3 Viewer

- read-only access to dashboard, agent overview, selected logs, usage, sessions
- no destructive actions
- no secret access

### 8.4 v1 Minimum

If full role management is deferred, still implement action gating internally so destructive endpoints can be wrapped later without route redesign.

## 9. Primary User Flows

### 9.1 Create Agent

1. Open create page
2. Choose template or clone source
3. Set agent name and runtime type
4. Choose provider/model preset or custom credential mapping
5. Set workspace seed or upload starter files if needed
6. Launch runtime
7. Run health checks
8. Redirect to agent detail overview

### 9.2 Open Agent Overview

1. See runtime status
2. See workspace presence and recent file changes
3. See last session activity
4. See health and quick actions
5. Jump to terminal/workspace/sessions/logs

### 9.3 Browse Workspace

1. Open workspace tab
2. Browse folders in a left-side tree
3. Open file preview in main panel
4. Upload file to current folder
5. Rename, move, download, or delete with confirmation

### 9.4 Operate Runtime

1. Start/stop/restart/reset from overview or action bar
2. Open terminal
3. Inspect logs if health degrades
4. Create backup before risky operations

### 9.5 Review Sessions and Activity

1. Open sessions tab
2. Filter by source or status
3. Open individual session summary
4. Inspect model/provider/tokens/cost
5. Correlate with logs and file changes if possible

## 10. Feature Scope

## 10.1 Must-Have v1

- agent dashboard
- create agent flow
- agent detail overview
- browser terminal
- workspace browser
- file preview
- file upload
- file download
- file rename
- file delete
- create folder
- logs view
- sessions list
- activity list
- credential management
- backup and restore management
- safer config/meta presentation

## 10.2 Strongly Recommended v1.1

- inline file editor for text files
- drag-and-drop upload
- agent tagging and filtering
- search across agents and files
- recent file changes widget
- per-agent health metrics panel

## 10.3 Good v2 Features

- multi-user auth with session cookies
- per-user permissions
- audit UI
- model usage budgets and alerting
- cron/task management
- MCP service management
- agent templates marketplace/presets

## 11. Production Requirements by Surface

## 11.1 Agent Dashboard

Must show:

- agent name
- display name if different
- current status
- runtime type
- last activity time
- provider/model summary
- workspace status
- quick actions

Should support:

- search
- status filter
- agent type filter
- tag filter
- sort by activity

Must not show as primary content:

- root password
- raw container IDs
- raw config dumps

## 11.2 Agent Detail Overview

Must show:

- health banner
- runtime summary
- workspace summary
- latest session summary
- recent activity feed
- quick action buttons

Must avoid:

- one long mixed infra page
- making logs/config the first thing the user sees

## 11.3 Workspace Browser

Must support:

- tree/list navigation
- breadcrumb path
- file metadata
- preview of text/code/json/log/markdown/config files
- upload to current directory
- new folder
- rename
- move
- delete with confirmation
- download

Must enforce:

- root boundary checks
- no absolute path access from client
- no hidden secret path escape
- file size limits on upload
- denylist or confirmation for risky binary handling if needed

## 11.4 Terminal

Must support:

- full-width browser terminal
- proper PTY sizing
- Bash history and normal arrow key behavior
- reconnect messaging
- explicit connection state

Must enforce:

- route validation
- auth checks
- known runtime target only
- session logging if possible

## 11.5 Sessions and Activity

Must support:

- chronological list
- filter by status and source
- timestamps
- summary text
- provider/model visibility
- token and cost visibility when available

Should support later:

- drill-in session detail
- linked files changed during run
- linked logs around run timestamps

## 11.6 Credentials

Must support:

- saved API keys
- saved bot tokens
- saved user IDs
- provider presets
- usage references by agent

Must enforce:

- masking in UI
- no accidental exposure via config views
- no plaintext echo in normal responses

## 11.7 Backups and Restore

Must support:

- per-agent backups
- fleet-level backup listing
- restore with explicit target confirmation
- download and delete safely

Must enforce:

- safe filename handling
- scoped restore targets
- audit logging

## 12. Architecture Plan

## 12.1 High-Level Layers

### Presentation Layer

- EJS templates or future frontend
- HTMX interactions or API-driven UI
- browser terminal

### Application Layer

- route handlers
- auth and authorization middleware
- input validation
- response shaping

### Domain Services Layer

- agent registry service
- workspace service
- runtime service
- session service
- activity service
- credential service
- backup service

### Infrastructure Layer

- Docker runtime interaction
- filesystem access
- persisted app metadata store
- usage CSV reader and future normalized metrics store

## 12.2 Domain Services to Create

### Agent Registry Service

Responsibilities:

- discover agents
- normalize metadata
- map agent to runtime and workspace paths
- provide one consistent view model

### Workspace Service

Responsibilities:

- list directory
- stat file
- read file
- preview file
- upload file
- download file
- create folder
- rename file/folder
- move file/folder
- delete file/folder
- enforce workspace root boundaries

### Runtime Service

Responsibilities:

- start, stop, restart, reset, remove
- return status and health info
- open terminal target safely
- provide logs access

### Session Service

Responsibilities:

- aggregate session data from agent/runtime sources
- normalize run summaries
- expose filters and summaries

### Activity Service

Responsibilities:

- write structured audit events
- read activity by agent and globally
- correlate important actions

### Credential Service

Responsibilities:

- store and retrieve references
- mask secrets
- validate provider metadata
- report usage relationships

### Backup Service

Responsibilities:

- list backups
- validate paths
- create backups
- restore backups
- delete backups safely

## 13. Data Storage Plan

## 13.1 Keep Existing Sources Initially

- `instances/*/meta.env`
- existing config files
- Docker state
- `usage_data.csv`
- existing credentials JSON

## 13.2 Add an App Metadata Store

Recommended:

- SQLite for normalized metadata and audit data

Suggested tables:

- `agents`
- `agent_tags`
- `agent_credentials`
- `sessions`
- `activity_events`
- `uploads`
- `user_accounts`
- `roles`
- `permissions`

### Why SQLite First

- local and self-hosted friendly
- simple deployment
- fits current project scale
- good enough for control plane metadata

## 13.3 Storage Rules

- secrets should not be duplicated unnecessarily
- workspace files remain in agent workspace roots
- database stores metadata, relationships, indexes, and audit records
- large logs remain streamed from source or summarized into metadata

## 14. API Plan

All new APIs should be agent-first, not VM-first.

## 14.1 Agent Routes

- `GET /agents`
- `GET /agents/create`
- `POST /agents`
- `GET /agents/:agentId`
- `POST /agents/:agentId/start`
- `POST /agents/:agentId/stop`
- `POST /agents/:agentId/restart`
- `POST /agents/:agentId/reset`
- `POST /agents/:agentId/remove`

## 14.2 Workspace Routes

- `GET /agents/:agentId/workspace`
- `GET /agents/:agentId/workspace/tree?path=`
- `GET /agents/:agentId/workspace/file?path=`
- `POST /agents/:agentId/workspace/upload`
- `POST /agents/:agentId/workspace/folder`
- `POST /agents/:agentId/workspace/rename`
- `POST /agents/:agentId/workspace/move`
- `POST /agents/:agentId/workspace/delete`
- `GET /agents/:agentId/workspace/download?path=`

## 14.3 Session and Activity Routes

- `GET /agents/:agentId/sessions`
- `GET /agents/:agentId/sessions/:sessionId`
- `GET /agents/:agentId/activity`
- `GET /activity`

## 14.4 Runtime and Diagnostics Routes

- `GET /agents/:agentId/logs`
- `GET /agents/:agentId/config`
- `GET /agents/:agentId/health`
- `GET /system/health`
- `GET /system/diagnostics`

## 14.5 Credential Routes

- `GET /credentials`
- `POST /credentials/api-keys`
- `POST /credentials/bot-tokens`
- `POST /credentials/user-ids`
- `POST /credentials/:kind/:id/delete`

## 14.6 Backup Routes

- `GET /backups`
- `POST /backups/:agentId/create`
- `POST /backups/:agentId/restore`
- `GET /backups/:backupId/download`
- `POST /backups/:backupId/delete`

## 14.7 API Rules

- validate all inputs
- return consistent status codes
- never trust raw filenames from URL blindly
- never trust raw paths from client blindly
- redact secrets in serialized responses
- prefer JSON for API surfaces and EJS/HTMX for page rendering shells where helpful

## 15. Security Plan

## 15.1 Threat Model

Main risk areas:

- path traversal in workspace operations
- arbitrary file overwrite on upload
- secret leakage via config, logs, or API responses
- terminal access to unintended targets
- backup file path abuse
- CSRF on mutating endpoints
- insufficient auth for destructive actions
- XSS via file previews or logs
- denial of service via huge file uploads or huge previews

## 15.2 Security Controls Required

### Authentication

- production should move beyond a single shared Basic Auth password
- minimum acceptable next step: session-based auth with logout support
- future-ready for multi-user roles

### Authorization

- central permission checks for destructive actions
- workspace permissions and terminal permissions separated logically

### Input Validation

- validate agent IDs
- validate filenames
- validate relative paths
- validate upload sizes and types
- validate action payloads with explicit allowlists

### Filesystem Safety

- resolve all user paths against workspace root
- reject path traversal
- reject symlink escapes if possible
- never perform file ops outside approved roots

### Secret Protection

- mask secrets in UI
- redact secrets in config JSON responses
- avoid echoing secret values in logs and flash messages

### Browser Security

- CSRF protection on mutating routes
- CSP header
- output escaping in previews and logs
- content-type discipline for downloads and previews

### Terminal Security

- validate route target exists and is allowed
- tie terminal session to authenticated user
- log terminal open/close events

### Rate Limiting

- apply basic rate limits to auth, upload, and destructive endpoints

## 15.3 Production Security Checklist

- auth not shared among all humans forever
- secret redaction verified
- file root enforcement verified
- backup path safety verified
- mutating routes protected
- upload size limits configured
- error pages do not leak stack traces publicly

## 16. Observability Plan

## 16.1 Control Plane Observability

Need:

- application logs
- error logs
- request logs
- audit logs
- uptime/health endpoint

## 16.2 Agent Observability

Need:

- runtime status
- recent sessions
- last activity timestamps
- usage metrics
- log tailing
- health summaries

## 16.3 Operational Metrics

Should capture:

- number of agents
- running agents
- failed health checks
- upload counts
- recent backups
- restore actions
- terminal opens
- session counts by source
- token usage trends

## 17. UX and Design Plan

## 17.1 Product Feel

- professional
- calm
- operational
- readable on laptop screens
- dense enough for admins, not noisy

## 17.2 Dashboard Principles

- immediate status clarity
- important signals first
- quick actions near status
- avoid decorative clutter

## 17.3 Workspace Principles

- familiar file explorer mental model
- fast path navigation
- clear current folder
- obvious upload target
- obvious distinction between preview and actions

## 17.4 Error Handling UX

- every action should return clear result
- destructive actions require confirmation
- upload errors explain why
- permission or boundary errors should be explicit, not generic

## 18. Migration Plan from Current UI

## 18.1 Rename Strategy

- shift user-facing copy from VM to Agent gradually
- keep backend compatibility temporarily
- map current VM names to agent names in the registry layer

## 18.2 Route Migration Strategy

- existing `/vm/...` routes remain temporarily
- new `/agents/...` routes introduced in parallel
- templates migrate to new routes progressively
- old routes deprecated once all major pages use agent-first surfaces

## 18.3 Data Migration Strategy

- existing credentials JSON remains source-of-truth initially
- metadata store begins as derived cache + audit store
- agent records can be backfilled from existing instances on startup

## 19. Detailed Phase Plan

## Phase 0: Foundations

Goals:

- define registry, storage, route, and security boundaries before UI sprawl grows further

Work:

- create agent registry abstraction
- define normalized agent model
- define workspace root resolution rules
- define metadata store schema
- define auth target state

Deliverables:

- architecture skeleton
- clear domain helpers
- migration notes

## Phase 1: Agent-First Reframe

Goals:

- shift the UI and route vocabulary from VM-first to agent-first

Work:

- add `/agents` routes
- reframe dashboard copy and cards
- reframe create page around agent creation
- hide low-level infra details from top-level views

Deliverables:

- operator sees a fleet of agents rather than a list of VMs

## Phase 2: Workspace Browser and File Operations

Goals:

- make file management a core product surface

Work:

- workspace tree panel
- file preview panel
- upload flow
- create folder
- rename/move/delete/download
- path safety enforcement

Deliverables:

- production-safe workspace operations for each agent

## Phase 3: Agent Detail Experience

Goals:

- create a polished operational hub per agent

Work:

- tabbed detail view
- overview health cards
- logs tab
- terminal tab
- config tab with redaction
- backups tab

Deliverables:

- one coherent agent detail experience

## Phase 4: Sessions and Activity

Goals:

- answer what the agent did without raw shell inspection

Work:

- session list and summaries
- activity timeline
- runtime events
- audit events
- usage correlations where available

Deliverables:

- per-agent history and accountability

## Phase 5: Production Security and Auth

Goals:

- stop relying on shared basic auth as the long-term model

Work:

- session auth
- role scaffolding
- CSRF
- audit log storage
- destructive action protection
- upload controls

Deliverables:

- production-safe access model

## Phase 6: Polish and Hardening

Goals:

- raise quality and close operational gaps

Work:

- loading and empty states
- action feedback
- keyboard-friendly file explorer
- performance tuning for large directories
- mobile/laptop layout checks
- observability improvements

Deliverables:

- polished control plane feel

## 20. Testing Plan

## 20.1 Unit-Level

- path normalization
- root boundary enforcement
- secret redaction helpers
- agent registry mapping
- upload validation

## 20.2 Integration-Level

- create agent flow
- workspace browse flow
- upload and download flow
- terminal open flow
- backup create and restore flow
- session listing flow

## 20.3 Security Tests

- path traversal attempts
- symlink edge cases
- oversized uploads
- invalid agent IDs
- config secret leakage checks
- unauthorized action attempts

## 20.4 Manual Acceptance Tests

- create new agent
- clone existing agent
- browse workspace
- upload file and preview it
- open terminal and run commands
- create backup and restore backup
- inspect session history
- verify hidden secrets stay hidden

## 21. Release Gates

Before calling the system production-ready, all of these should be true:

- agent-first dashboard works end-to-end
- workspace browser supports safe upload/download/delete/rename/create folder
- terminal works reliably at full width with bash history
- all destructive file and backup actions are bounded and confirmed
- secrets are redacted in all UI/API surfaces
- auth story is stronger than shared basic auth or there is explicit documented acceptance of the risk
- structured logs and audit events exist
- restore workflow is tested
- error states are understandable

## 22. Known Risks to Watch During Implementation

- feature creep into too many infra-management pages before core workspace features are solid
- trying to solve enterprise multi-user before single-admin workflows are excellent
- leaking low-level Docker details into every template
- bolting file operations onto routes without a proper workspace service
- trusting relative paths from client without canonicalization
- mixing preview and raw file download behavior unsafely
- letting config/meta surfaces remain secret-leaky during the transition

## 23. Explicit Build Priorities

If time is limited, prioritize in this order:

1. agent registry abstraction
2. agent-first dashboard and detail skeleton
3. workspace browser with safe file operations
4. terminal and logs integration
5. sessions and activity surfaces
6. stronger auth and audit model
7. polish and advanced observability

## 24. Acceptance Criteria

The product should be considered aligned with this plan when:

1. the operator thinks in terms of agents, not raw VMs
2. each agent has a clean overview page
3. each agent has a safe, useful workspace browser
4. file upload is available and safe
5. terminal, logs, sessions, and activity are all reachable from the agent detail experience
6. credentials, backups, and settings are centrally manageable
7. the app is self-hosted, production-conscious, and operationally trustworthy

## 25. File Location

This plan file is stored at:

- `AGENT_MANAGEMENT_PLAN.md`

in the repository root:

- `/home/boniface/www/vm-friends/AGENT_MANAGEMENT_PLAN.md`
