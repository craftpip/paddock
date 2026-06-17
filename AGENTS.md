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
- **Script**: `scripts/record-usage.sh` uses `openclaw status --usage --json` for clean JSON with `usedPercent`/`resetAt`, and `openclaw sessions list --json` for per-session `totalTokens`. No more fragile grep parsing.
- **Budget script**: `scripts/usage-budget.sh` — interactive report showing weekly %, burn rate, projection, session breakdown by kind (direct/cron/telegram), and headroom.
- **Data source**: `openclaw status --usage --json` returns `usage.providers[].windows[]` with `label` ("5h" / "Week"), `usedPercent`, and `resetAt` (Unix ms).
- **Output**: Appends one row to `usage_data.csv` at project root.
- **CSV columns**: `timestamp`, `hourly_usage`, `hourly_pct_left`, `hourly_reset_in`, `weekly_pct_left`, `weekly_reset_in`, `total_tokens_k`, `tokens_delta_k`, `plan`.
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

## Project Learnings

### Updating vm-ozden OpenClaw to latest

**Created:** 2026-06-13  
**Last updated:** 2026-06-13

**Trigger:** User asked to update the OpenClaw instance inside `vm-ozden`, wanted latest only, and then asked to learn it.

**Mistake / Problem:** A backup was started even though the user already had one. Also, OpenClaw `:latest` updates can trigger state migrations, and after updating to `2026.6.6` the Gateway accepted Telegram messages but agent replies failed because OpenAI auth had to be refreshed.

**Correct Approach:** First record the current version with `docker exec vm-ozden openclaw --version`. If the user says they already have a backup, do not create another backup. Update only `vm-ozden` with `docker compose build --pull vm-ozden && docker compose up -d --no-deps --force-recreate vm-ozden`. Then record the new version and image digest. After update, check OpenAI auth; if needed, have the user complete interactive device auth because non-TTY tool sessions cannot run `docker exec -it`.

**Verification:** Check `docker compose ps vm-ozden`, `docker exec vm-ozden openclaw --version`, `docker exec vm-ozden openclaw cron list`, recent `docker logs --since 2m vm-ozden`, and send a Telegram test using `docker exec vm-ozden openclaw message send --channel telegram --target 7283352340 --message "Test from vm-ozden after OpenClaw update"`. Also verify agent/OpenAI auth with `docker exec vm-ozden openclaw models status` and `docker exec vm-ozden openclaw agent --agent dev --message "Reply with OK only"`. If Telegram can send messages but replies fail with `401 Unauthorized: Missing bearer or basic authentication`, ask the user to run `docker exec -it vm-ozden openclaw models auth login --provider openai --force --device-code`, then re-run the auth and agent checks.

**Scope:** Applies when updating the OpenClaw Docker image/container for `vm-ozden` in this repo.

**Related terms:** openclaw update, vm-ozden, docker compose build --pull, latest, version record, telegram test, no backup, OpenAI auth, 401 Unauthorized, device-code



### Issue: Usage tracking broke after OpenClaw 2026.6.6 — grep pattern for provider name changed

**Created:** 2026-06-15
**Last updated:** 2026-06-15

**Trigger:** User reported usage tracking cron was running but CSV columns were empty.

**Mistake / Problem:** The script `scripts/record-usage.sh` greps for `- openai-codex usage:` to parse the usage line from `openclaw models status`. OpenClaw 2026.6.6 renamed the provider from `openai-codex` to `openai` in the output. The grep found no match, `|| true` prevented a crash, but the usage variables stayed empty — silent data loss.

**Correct Approach:** When OpenClaw updates, always check `docker exec vm-ozden openclaw models status` output for provider name changes. The usage line format is: `- openai usage: 5h 97% left ⏱3h 36m · Week 48% left ⏱2d 7h`. Update grep to match `- openai usage:`.

**Verification:** Run the script manually and check `tail -1 usage_data.csv` — all usage columns should be populated, not empty.

**Scope:** Applies to `scripts/record-usage.sh` in this repo after any OpenClaw version update.

**Related terms:** record-usage.sh, openclaw models status, openai-codex, openai usage, grep pattern, usage tracking breaking


### vm-ozden Telegram failures can come from host-side Telegram reachability

**Created:** 2026-06-16  
**Last updated:** 2026-06-16

**Trigger:** User asked why OpenClaw in `vm-ozden` was failing and later asked to learn the result.

**Mistake / Problem:** Time was wasted looking at container-specific causes before verifying whether the host itself could reach Telegram. `vm-ozden` does not route through gluetun, so host-side reachability problems to `api.telegram.org` affect OpenClaw Telegram sends directly.

**Correct Approach:** When `vm-ozden` shows Telegram send failures like `Network request for 'sendMessage' failed!` or `UND_ERR_CONNECT_TIMEOUT`, first test Telegram from the host with `curl -sv --connect-timeout 5 https://api.telegram.org`. If the host also times out while normal HTTPS still works, treat it as a host/network or regional restriction issue, not a Docker/container issue. For this incident, an Economic Times article reported temporary Telegram access restrictions in India until `2026-06-22`, which matched the observed host timeout.

**Verification:** Confirm `curl -sv --connect-timeout 5 https://api.telegram.org` times out on the host, confirm `curl -s -o /dev/null -w '%{http_code}\n' --connect-timeout 5 https://example.com` still succeeds, and check `docker logs --since 30m vm-ozden` for Telegram timeout errors.

**Scope:** Applies when diagnosing sudden Telegram failures in `vm-ozden` or other containers that use the host's normal outbound path.

**Related terms:** vm-ozden, telegram, api.telegram.org, timeout, UND_ERR_CONNECT_TIMEOUT, host network, regional restriction, India, Economic Times


### Treat apparent praise as possible sarcasm during failures

**Created:** 2026-06-16  
**Last updated:** 2026-06-16

**Trigger:** User said `This is great. learn` after a frustrating Telegram outage investigation, then clarified it was sarcasm.

**Mistake / Problem:** The response treated praise literally even though the surrounding context was a broken system and user frustration. That led to recording the learning with the wrong emotional framing.

**Correct Approach:** When the user uses positive phrases like `great` or similar immediately after a failure, outage, or frustrating debugging session, treat them as possible sarcasm and confirm the actual lesson from the technical outcome rather than the literal praise.

**Verification:** Before recording a learning or summarizing success, check whether the surrounding context indicates frustration, breakage, or complaint. If so, phrase the learning around the real problem and fix, not around apparent praise.

**Scope:** Applies to user communication and project learning updates in this repo, especially during incident debugging.

**Related terms:** sarcasm, praise, frustration, learn, AGENTS, outage, debugging, wording

### Usage-budget.sh — burn rate breakdown by day and 3h block

**Created:** 2026-06-16  
**Last updated:** 2026-06-16

**Trigger:** User wanted to understand the 1.5%/h burn rate and see consumption broken down by time of day and day of week.

**Old version:** `usage-budget.sh` only showed a single overall burn rate (e.g., 1.5%/h). Without breakdown by time/day, it looked like every hour consumed that much — misleading since it's a spread average over busy and quiet periods.

**Correct Approach:** `scripts/usage-budget.sh` now:
- Records each burn rate reading with its IST day-of-week, hour, and 3-hour block
- Prints a Day × 3h block matrix (Mon-Sun rows × 8 IST time blocks)
- Prints by-day-of-week and by-3h-block summaries alongside the existing outputs

**Verification:** Run `bash scripts/usage-budget.sh` and check the "Burn rate breakdown" section at the bottom.

**Scope:** Applies to `scripts/usage-budget.sh` in this repo. CSV needs >1 week of data for the matrix to fill meaningfully.

**Related terms:** usage-budget.sh, burn rate, breakdown, day of week, 3-hour block, IST, weekly_pct_left

