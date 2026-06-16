# Usage Data Tracking

Records OpenAI usage from `vm-ozden` every hour via crontab.

## Scripts

- **`scripts/record-usage.sh`** — runs `openclaw status --usage --json` and `openclaw sessions list --json` to collect usage data. Appends one row to `usage_data.csv`.
- **`scripts/usage-budget.sh`** — interactive budget report showing current usage, burn rate, projection, session breakdown, and headroom.

## CSV Schema

| Column | Description |
|---|---|
| `timestamp` | ISO 8601 UTC |
| `hourly_usage` | Hours used in current window (deprecated, empty in new rows) |
| `hourly_pct_left` | Percentage of hourly quota remaining |
| `hourly_reset_in` | Time until hourly quota resets (e.g. `3h 17m`) |
| `weekly_pct_left` | Percentage of weekly quota remaining |
| `weekly_reset_in` | Time until weekly quota resets (e.g. `2d 7h`) |
| `total_tokens_k` | Sum of all session context tokens (raw, not k) |
| `tokens_delta_k` | Tokens used since previous recording |
| `plan` | OpenAI plan name (e.g. `plus ($0.00)`) |

## Calculating Weekly Token Limit

When `weekly_pct_left > 0`:

```
weekly_cap = total_tokens_k / ((100 - weekly_pct_left) / 100)
```

Example: 600k tokens at 47% left → weekly cap = 600 / 0.53 ≈ 1,132k tokens.

## Crontab

- `0 * * * * /home/boniface/www/vm-friends/scripts/record-usage.sh` — hourly recording
- `0 18 * * * /home/boniface/www/vm-friends/scripts/daily-commit.sh` — daily commit
