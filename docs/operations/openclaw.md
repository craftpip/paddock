# OpenClaw Operations

OpenClaw-specific operational knowledge: cron storage, model provider auth,
version updates, and model memory. Always confirm current CLI behavior against
the [online docs](https://docs.openclaw.ai) — commands and config change
frequently.

> Last updated: 2026-08-09

## Cron System

### Storage

Since OpenClaw 2026.4.x cron uses **SQLite** at `state/openclaw.sqlite`
(tables `cron_jobs`, `cron_run_logs`). `cron/jobs.json` is legacy — the
Gateway no longer reads it on startup and does not auto-import it. Import old
entries with `openclaw doctor --fix`. New jobs added via `openclaw cron add`
or the Gateway cron tool go only to SQLite.

### Cron jobs capture the model at creation time

Jobs store the model string when created and do not auto-update when
`agents.defaults.model.primary` changes. Update a job with
`openclaw cron update <id> --model <new-model>` or delete and recreate. Check
the current model per job with `openclaw cron list`.

### Persistence across container recreates

`state/openclaw.sqlite` lives inside the bind mount and persists. Rebuilding
containers against a new `:latest` image can silently lose data if the storage
format changed and a migration step (`doctor --fix`) was missed.

### The `:latest` tag risk

The Dockerfile base is `ghcr.io/openclaw/openclaw:latest`, and OpenClaw ships
breaking changes (e.g. the JSON → SQLite cron move) under the same tag. Pin a
version (e.g. `v2026.6.1`) to avoid surprise changes.

## Model Provider API Keys

Set a provider key with `openclaw models auth paste-api-key --provider <name>`
inside the container. For `ollama-cloud` this also sets
`ollama-cloud/gemma4:31b` as the default model when none is configured.
Providers confirmed working: `openrouter`, `ollama-cloud`. Verify with
`docker exec <pad> openclaw models auth list --json`.

### `paste-api-key` destroys the config

Running `paste-api-key` overwrites the **entire** `openclaw.json` with auth
info only, destroying agents/gateway/plugin config. Always save the config
before invoking it and merge it back after. It reads the key from stdin — use
`spawn` and write to `child.stdin`; `child_process.execFile` (no stdin) hangs
until timeout.

## Updating OpenClaw

1. Record the current version: `docker exec <pad> openclaw --version`.
2. If the user says they already have a backup, do not create another.
3. Update: `docker compose build --pull <pad> && docker compose up -d
   --no-deps --force-recreate <pad>`, then record the new version and image
   digest.
4. After the update, check OpenAI auth; non-TTY sessions cannot run
   `docker exec -it`, so device-code re-auth needs the user.

Verify: `docker compose ps <pad>`, `openclaw --version`, `openclaw cron list`,
recent `docker logs --since 2m <pad>`, and a Telegram test. Check agent/OpenAI
auth with `openclaw models status` and `openclaw agent --agent dev --message
"Reply with OK only"`. If Telegram sends but replies fail with `401
Unauthorized`, ask the user to run `docker exec -it <pad> openclaw models auth
login --provider openai --force --device-code`, then re-run the checks.

## Host-Side Telegram Reachability

Agents not routing through a peer are affected directly by host-side
reachability to `api.telegram.org`. On send failures
(`Network request for 'sendMessage' failed!`, `UND_ERR_CONNECT_TIMEOUT`) first
test from the host: `curl -sv --connect-timeout 5 https://api.telegram.org`.
If the host times out while normal HTTPS works, it is a host/network or
regional restriction. Check `docker logs --since 30m <pad>` for the timeout
errors.

## Local Vector Memory (Semantic Search)

Self-contained local semantic memory uses ChromaDB + local GGUF embeddings
(no cloud API):

1. Install the provider plugin: `openclaw plugins install
   @openclaw/llama-cpp-provider`.
2. Enable it in `plugins.entries` of `openclaw.json`:
   `"llama-cpp": { "enabled": true }`.
3. Configure `memorySearch` under `agents.defaults`:
   `"memorySearch": { "provider": "local", "local": { "modelPath":
   "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf" } }`.
4. Restart the container: `docker compose restart <pad>`.
5. Run the index: `openclaw memory index`.

Notes: everything runs CPU-only inside the container; changing the embedding
provider/model invalidates the index (rebuild with `openclaw memory index
--force`); enable the `active-memory` plugin for interactive semantic recall.

## See Also

- [operations overview](overview.md) — lifecycle, dev workflow, git
- [overview architecture](../overview/architecture.md)
