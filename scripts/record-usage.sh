#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CSV_FILE="$PROJECT_DIR/usage_data.csv"
CONTAINER="vm-ozden"

# --- OpenAI usage limits ---
MODELS_OUTPUT=$(docker exec "$CONTAINER" openclaw models status 2>&1 || true)

RAW=$(echo "$MODELS_OUTPUT" | grep -- '- openai usage:' | sed 's/.*openai usage: //' || true)

HOURLY=$(echo "$RAW" | sed 's/ ·.*//')
WEEKLY=$(echo "$RAW" | sed 's/.*· //')

HOURLY_USAGE=$(echo "$HOURLY" | awk '{print $1}')
HOURLY_PCT=$(echo "$HOURLY" | grep -oP '\d+(?=% left)' || true)
HOURLY_RESET=$(echo "$HOURLY" | grep -oP '(?<=⏱).+' || true)

WEEKLY_PCT=$(echo "$WEEKLY" | grep -oP '\d+(?=% left)' || true)
WEEKLY_RESET=$(echo "$WEEKLY" | grep -oP '(?<=⏱).+' || true)

if [[ -z "$RAW" ]]; then
    echo "[record-usage] WARN: no 'openai usage' line in models status output — skipping write" >&2
    exit 0
fi

# --- Session token usage ---
STATUS_OUTPUT=$(docker exec "$CONTAINER" openclaw status 2>&1 || true)

TOTAL_TOKENS_K=0
while IFS= read -r val; do
    TOTAL_TOKENS_K=$((TOTAL_TOKENS_K + val))
done < <(echo "$STATUS_OUTPUT" | grep -oP '\b[0-9]+(?=k/)' || true)

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# --- Delta from previous row ---
TOKENS_DELTA_K=0
if [[ -f "$CSV_FILE" ]]; then
    LAST_ROW=$(tail -1 "$CSV_FILE")
    LAST_TOTAL=$(echo "$LAST_ROW" | awk -F',' '{print $(NF-1)}')
    if [[ -n "$LAST_TOTAL" && "$LAST_TOTAL" =~ ^[0-9]+$ ]]; then
        TOKENS_DELTA_K=$((TOTAL_TOKENS_K - LAST_TOTAL))
    fi
fi

if [[ ! -f "$CSV_FILE" ]]; then
    echo "timestamp,hourly_usage,hourly_pct_left,hourly_reset_in,weekly_pct_left,weekly_reset_in,total_tokens_k,tokens_delta_k" > "$CSV_FILE"
fi

echo "$TIMESTAMP,$HOURLY_USAGE,$HOURLY_PCT,$HOURLY_RESET,$WEEKLY_PCT,$WEEKLY_RESET,$TOTAL_TOKENS_K,$TOKENS_DELTA_K" >> "$CSV_FILE"
