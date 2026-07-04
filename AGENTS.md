# VM Friends Project — Agent Learnings

## How to Use This File

When the user says "remember" or "write this down in AGENTS.md", or whenever you encounter a problem, solve it, and learn something new — **write it here**. This includes:
- Commands that worked (or didn't work)
- Bug fixes and their root causes
- Project structure details
- Configuration quirks
- Any decision the user makes about how things should work

Append new entries under the relevant section or add a new section. Keep it concise but actionable so future agent sessions benefit.

## Project Structure

- **`docker-compose.yml`** defines services (vm-ozden, vm-pranav).
- **`docker-compose.override.yml`** adds vm-jake, vm-ozden2, vm-reze, vm-test.
- **`vm_openclaw/`** Docker image builds from `ghcr.io/openclaw/openclaw:latest`.
- **`instances/<vm>/openclaw/`** is bind-mounted to `/root/.openclaw` inside each container.
- Scripts: `add-vm.sh`, `remove-vm.sh`, `reset-vm.sh`.

## OpenClaw Cron System

### Storage (version 2026.4.x+)

- Cron uses **SQLite** at `state/openclaw.sqlite` (tables: `cron_jobs`, `cron_run_logs`).
- **`cron/jobs.json` is legacy** — the Gateway no longer reads from it on startup. It is **not** auto-imported.
- To import old `jobs.json` entries into SQLite, run: `openclaw doctor --fix`
- New jobs added via `openclaw cron add` or the Gateway cron tool call go **only** to SQLite.

### Persistence Across Container Recreates

- `state/openclaw.sqlite` is inside the bind mount → persists.
- `cron/jobs.json` is also persisted on disk but is **stale** — not the source of truth.
- If containers are rebuilt (e.g., `docker compose build` pulls a new `:latest` image), a version change can cause silent data loss if the storage format changed and a migration step (like `doctor --fix`) was missed.

### `:latest` Tag Risk

- The Dockerfile uses `FROM ghcr.io/openclaw/openclaw:latest`.
- OpenClaw releases breaking changes (e.g., JSON → SQLite cron storage) under the same `:latest` tag.
- Pin a version (`v2026.6.1`) to avoid surprise changes.

## Git / Versioning

### File Permissions

- Instance files are owned by `root` (Docker creates them). Must use `sudo` for git operations on them.
- Example: `sudo git add -A && sudo git commit -m "msg"`

### Executable Bit Loss on Commit

- `sudo git add -A` resets executable bits to whatever git has in its index. A script made executable via `chmod +x` will lose that bit on the next commit if git tracks it as mode 100644.
- **Fix**: `sudo git update-index --chmod=+x <file>` to update the index, then commit. This permanently sets the mode to 100755.
- Affected: `scripts/record-usage.sh` kept losing its executable bit every daily commit until fixed in git's index.

### Embedded Git Repos

- OpenClaw creates nested git repos in:
  - `instances/*/openclaw/agents/*/agent/codex-home/.tmp/plugins*/`
  - `instances/*/openclaw/workspace/`
- These must have their `.git/` directories removed before `git add`, or they get added as submodules (mode 160000).
- Fix: `sudo find instances/ -path '*/.tmp/plugins*' -name '.git' -type d -exec rm -rf {} +`

### .gitignore

Current rules:

```
instances/*/openclaw/npm/
**/node_modules/
```

The `npm/` folder is OpenClaw's internal plugin cache (not project dependencies). `node_modules/` lives inside it and is equally unnecessary to version.

## Usage Tracking (OpenAI API)

- **Cron**: `*/15 * * * * /home/boniface/www/vm-friends/scripts/record-usage.sh` — runs every 15 minutes.
- **Target container**: `vm-jake` — both `record-usage.sh` and `usage-budget.sh` read from vm-jake (migrated from vm-ozden on 2026-07-01).
- **Script**: `scripts/record-usage.sh` uses `openclaw status --usage --json` for clean JSON with `usedPercent`/`resetAt`, and `openclaw sessions list --json` for per-session `totalTokens`.
- **Budget script**: `scripts/usage-budget.sh` — interactive report showing weekly %, burn rate, projection, session breakdown by kind (direct/cron/telegram), and headroom.
- **Data source**: `openclaw status --usage --json` returns `usage.providers[].windows[]` with `label` ("5h" / "Week"), `usedPercent`, and `resetAt` (Unix ms).
- **Output**: Appends one row to `usage_data.csv` at project root.
- **CSV columns**: `timestamp`, `hourly_usage`, `hourly_pct_left`, `hourly_reset_in`, `weekly_pct_left`, `weekly_reset_in`, `total_tokens_k`, `tokens_delta_k`, `plan`.
- **Delta tracking**: Computes `tokens_delta_k` as difference from last row's `total_tokens_k`.
- **Auto-commit**: `0 18 * * * /home/boniface/www/vm-friends/scripts/daily-commit.sh` commits and pushes `usage_data.csv` daily.

## Daily Commit

- `scripts/daily-commit.sh` runs at 18:00 daily via crontab.
- Does `sudo git add -A && sudo git commit -m "auto: daily commit" && sudo git push`.



## Onboard Bot Script

- **Script**: `scripts/onboard-bot.sh` — automates `openclaw onboard` + Telegram + API key setup for a running VM.
- **Flow**:
  1. First run: generates skeleton config, adds Telegram channel with allowlist.
  2. Saves/reads credentials from `bot-prefixes.json` (gitignored).
  3. Supports API key providers (`--api-key`, `--setup-api-key`).
  4. OAuth and device-code flows are disabled in the script but kept for future debugging.
- **Telegram credentials**: Stored in `bot-prefixes.json` at project root (gitignored).
- **Structure**:
  ```json
  {
    "bots": { "wilmaa_bot": "8775500299:AAF__..." },
    "users": { "boniface": "532156945" }
  }
  ```

### Save credentials with a name (persists to bot-prefixes.json):
  ```bash
  --add-bot <name>=<token>     Save a Telegram bot token
  --add-user <name>=<id>       Save a Telegram user ID
  ```

### Use by saved name:
  ```bash
  --bot <name>       Look up bot token from bot-prefixes.json
  --user <name>      Look up user ID from bot-prefixes.json
  ```

### Other flags:
  ```bash
  --bot-token <token>     Direct bot token (no save)
  --allow-from <id>       Direct user ID (no save)
  --api-key <prov>=<key>  Set provider API key (repeatable)
  --setup-api-key         Interactive provider API key setup
  --reset                 Wipe config + kill stale auth
  --continue              Finalize after device-code auth
  --redirect-url <url>    Complete OAuth with redirect URL
  ```

### Full workflow for a new VM:
  1. `sudo bash add-vm.sh vm-xxx`
  2. Save credentials (one-time): `--add-bot mybot=123:ABC --add-user alice=987`
  3. Onboard: `sudo bash scripts/onboard-bot.sh vm-xxx --bot mybot --user alice`
  4. Set API keys: `sudo bash scripts/onboard-bot.sh vm-xxx --api-key ollama-cloud=<key>`

### Legacy (OAuth / Device-code) — kept for debugging:
- **OAuth process**: Writes `/tmp/oauth-helper-<vm>.py` inside the container. The helper uses a PTY, strips ANSI/control output, waits until the OAuth URL is detected before blocking on the FIFO, and writes raw debug output to `/tmp/onboard-oauth-<vm>.url.repr`.
- **OAuth failure-path rule**: Keep all OAuth temp paths defined in both `setup_auth_oauth` and `complete_auth_oauth`; with `set -u`, completion error-reporting must not reference setup-local variables such as `c_log` unless redefined locally. Verify failed-auth paths as well as success paths.
- **Device-code process**: Uses `script -q -c` inside `docker exec` to create a pseudo-TTY for `openclaw models auth login --device-code`, then runs it in background with `nohup` + `disown` so it survives script exit.
- **Requirements**: VM must already exist (created with `add-vm.sh`) and be running.

## Provider API Keys via `--api-key`

- Uses `openclaw models auth paste-api-key --provider <name>` inside the container.
- For `ollama-cloud`, automatically sets `ollama-cloud/gemma4:31b` as default model when no model is configured.
- Providers confirmed working: `openrouter`, `ollama-cloud`.
- To verify: `docker exec <vm> openclaw models auth list --json`


## Known Issues & Fixes

### File Ownership

- `AGENTS.md` at project root is owned by `root` (like instance files). Cannot use the `edit` tool — must use `sudo python3` or `sudo sed` to modify it.
- When using `sudo python3` with embedded code, use `<< 'PYEOF'` (single-quoted heredoc delimiter) to prevent bash from interpreting backticks and `$` inside the Python code.

### Issue: Usage tracking cron misses hours silently

**Cause**: `scripts/record-usage.sh` uses `set -euo pipefail`. When a command fails (e.g., container down, output format change), the pipeline exits non-zero and `set -e` kills the script before writing to CSV — no error visible, no row logged.

**Fix**: Added `|| true` to all `docker exec` and pipelines so no-match doesn't abort. Added an early-exit guard that logs a warning to stderr and exits 0 when the usage data can't be parsed.

### Issue: Cron jobs exist in `jobs.json` but not in `openclaw cron list`

**Cause**: The Gateway (v2026.4.x+) reads from SQLite, not `jobs.json`. The `jobs.json` is legacy and was never migrated.

**Fix**: `openclaw doctor --fix` inside the container.

### Issue: Embedded git repos inside `instances/` prevent `git add`

**Cause**: OpenClaw creates temporary git repos in `.tmp/` and `workspace/` directories.

**Fix**: Strip `.git/` directories before adding:
```bash
sudo find instances/ -name '.git' -type d -exec rm -rf {} + 2>/dev/null
```

## Project Learnings

### Updating OpenClaw to latest (vm-ozden / vm-jake pattern)

**Last updated:** 2026-07-01

**Correct Approach:** First record the current version with `docker exec <vm> openclaw --version`. If the user says they already have a backup, do not create another. Update with `docker compose build --pull <vm> && docker compose up -d --no-deps --force-recreate <vm>`. Then record the new version and image digest. After update, check OpenAI auth; if needed, have the user complete interactive device auth because non-TTY tool sessions cannot run `docker exec -it`.

**Verification:** Check `docker compose ps <vm>`, `docker exec <vm> openclaw --version`, `docker exec <vm> openclaw cron list`, recent `docker logs --since 2m <vm>`, and send a Telegram test. Also verify agent/OpenAI auth with `docker exec <vm> openclaw models status` and `docker exec <vm> openclaw agent --agent dev --message "Reply with OK only"`. If Telegram can send messages but replies fail with `401 Unauthorized`, ask the user to run `docker exec -it <vm> openclaw models auth login --provider openai --force --device-code`, then re-run the checks.

**Related terms:** openclaw update, docker compose build --pull, latest, version record, telegram test, no backup, OpenAI auth, 401 Unauthorized, device-code

### Issue: Usage tracking broke after OpenClaw 2026.6.6 — provider name changed

**Last updated:** 2026-07-01

**Problem:** `openclaw models status` renamed the provider from `openai-codex` to `openai`. The grep for `- openai-codex usage:` found no match — script survived but data was empty.

**Fix:** When OpenClaw updates, always check `docker exec <vm> openclaw models status` output for provider name changes. Current pattern: `- openai usage:`.

**Verify:** Run the script manually and check `tail -1 usage_data.csv` — all usage columns should be populated.

### Host-side Telegram reachability affects containers without gluetun

**Last updated:** 2026-07-01

**Problem:** `vm-ozden` and `vm-jake` do not route through gluetun, so host-side reachability problems to `api.telegram.org` affect their Telegram sends directly.

**Correct Approach:** When Telegram send failures happen (`Network request for 'sendMessage' failed!`, `UND_ERR_CONNECT_TIMEOUT`), first test from the host: `curl -sv --connect-timeout 5 https://api.telegram.org`. If the host also times out while normal HTTPS works, it's a host/network or regional restriction issue.

**Verify:** Check `docker logs --since 30m <vm>` for Telegram timeout errors, and confirm host can/cannot reach `api.telegram.org`.

### Usage-budget.sh — burn rate breakdown by day and 3h block

**Last updated:** 2026-07-01

**Details:** `scripts/usage-budget.sh` records each burn rate reading with IST day-of-week, hour, and 3-hour block. Prints a Day by 3h block matrix, by-day, and by-block summaries. CSV needs >1 week of data for the matrix to fill meaningfully.

**Related terms:** usage-budget.sh, burn rate, breakdown, day of week, 3-hour block
