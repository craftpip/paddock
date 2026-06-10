# Usage Data Tracking

Records OpenAI usage from `vm-ozden` every hour via crontab.

## Script

`scripts/record-usage.sh` — runs `docker exec vm-ozden openclaw models status` and `openclaw status` to collect usage data, appends one row to `usage_data.csv`.

## CSV Schema

| Column | Description |
|---|---|
| `timestamp` | ISO 8601 UTC |
| `hourly_usage` | Hours used in current hourly window (e.g. `5h`) |
| `hourly_pct_left` | Percentage of hourly quota remaining |
| `hourly_reset_in` | Time until hourly quota resets (e.g. `2h 5m`) |
| `weekly_pct_left` | Percentage of weekly quota remaining |
| `weekly_reset_in` | Time until weekly quota resets (e.g. `17h 36m`) |
| `total_tokens_k` | Sum of all session token counts (in thousands) |
| `tokens_delta_k` | Tokens used since previous recording |

## Calculating Weekly Token Limit

When `weekly_pct_left > 0`:

```
weekly_limit_k = total_tokens_k / ((100 - weekly_pct_left) / 100)
```

Example: 300k tokens at 40% left → weekly cap = 300 / 0.6 = 500k tokens.

At 0% left, we only know the lower bound: `weekly_limit_k >= total_tokens_k`.

## Crontab

Runs at the top of every hour (`0 * * * *`).
