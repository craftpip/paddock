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
- **`docker-compose.override.yml`** adds vm-ozden2, vm-reze.
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

- **Cron**: `0 * * * * /home/boniface/www/vm-friends/scripts/record-usage.sh` — runs every hour.
- **Script**: `scripts/record-usage.sh` runs `docker exec vm-ozden openclaw models status` and `openclaw status` to extract hourly/weekly usage percentages, reset times, and session token totals.
- **Output**: Appends one row to `usage_data.csv` at project root.
- **CSV columns**: `timestamp`, `hourly_usage`, `hourly_pct_left`, `hourly_reset_in`, `weekly_pct_left`, `weekly_reset_in`, `total_tokens_k`, `tokens_delta_k`.
- **Delta tracking**: Computes `tokens_delta_k` as difference from last row's `total_tokens_k`.
- **Auto-commit**: `0 18 * * * /home/boniface/www/vm-friends/scripts/daily-commit.sh` commits and pushes `usage_data.csv` daily.

## Daily Commit

- `scripts/daily-commit.sh` runs at 18:00 daily via crontab.
- Does `sudo git add -A && sudo git commit -m "auto: daily commit" && sudo git push`.

## Known Issues & Fixes

### File Ownership

- `AGENTS.md` at project root is owned by `root` (like instance files). Cannot use the `edit` tool — must use `sudo python3` or `sudo sed` to modify it.
- When using `sudo python3` with embedded code, use `<< 'PYEOF'` (single-quoted heredoc delimiter) to prevent bash from interpreting backticks and `$` inside the Python code.

### Issue: Usage tracking cron misses hours silently

**Cause**: `scripts/record-usage.sh` uses `set -euo pipefail`. When `grep` finds no match (e.g., container down, output format change), the pipeline exits non-zero and `set -e` kills the script before writing to CSV — no error visible, no row logged.

**Fix**: Added `|| true` to all `docker exec` and `grep` pipelines so no-match doesn't abort. Added an early-exit guard that logs a warning to stderr and exits 0 when the usage line can't be parsed.


### Issue: Cron jobs exist in `jobs.json` but not in `openclaw cron list`

**Cause**: The Gateway (v2026.4.x+) reads from SQLite, not `jobs.json`. The `jobs.json` is legacy and was never migrated.

**Fix**: `openclaw doctor --fix` inside the container.

### Issue: Embedded git repos inside `instances/` prevent `git add`

**Cause**: OpenClaw creates temporary git repos in `.tmp/` and `workspace/` directories.

**Fix**: Strip `.git/` directories before adding:
```bash
sudo find instances/ -name '.git' -type d -exec rm -rf {} + 2>/dev/null
```

