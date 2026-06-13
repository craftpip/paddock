#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CSV_FILE="$PROJECT_DIR/usage_data.csv"
CONTAINER="vm-ozden"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# --- OpenAI / OpenAI-Codex usage via host openclaw (still has the data) ---
HOURLY_USAGE=""
HOURLY_PCT=""
HOURLY_RESET=""
WEEKLY_PCT=""
WEEKLY_RESET=""

MODELS_OUTPUT=$(docker exec "$CONTAINER" openclaw models status 2>&1 || true)
RAW=$(echo "$MODELS_OUTPUT" | grep -- '- openai-codex usage:' | sed 's/.*openai-codex usage: //' || true)

if [[ -n "$RAW" ]]; then
    HOURLY=$(echo "$RAW" | sed 's/ ·.*//')
    WEEKLY=$(echo "$RAW" | sed 's/.*· //')
    HOURLY_USAGE=$(echo "$HOURLY" | awk '{print $1}')
    HOURLY_PCT=$(echo "$HOURLY" | grep -oP '\d+(?=% left)' || true)
    HOURLY_RESET=$(echo "$HOURLY" | grep -oP '(?<=⏱).+' || true)
    WEEKLY_PCT=$(echo "$WEEKLY" | grep -oP '\d+(?=% left)' || true)
    WEEKLY_RESET=$(echo "$WEEKLY" | grep -oP '(?<=⏱).+' || true)
fi

# --- Session token usage from container openclaw status ---
STATUS_OUTPUT=$(docker exec "$CONTAINER" openclaw status 2>&1 || true)
SESSION_COUNT=0
TOTAL_TOKENS_K=0

TOKEN_LINES=$(echo "$STATUS_OUTPUT" | grep -oP '\b[0-9]+(?=k/)' || true)
if [[ -n "$TOKEN_LINES" ]]; then
    while IFS= read -r val; do
        TOTAL_TOKENS_K=$((TOTAL_TOKENS_K + val))
    done <<< "$TOKEN_LINES"
    SESSION_COUNT=$(echo "$TOKEN_LINES" | wc -l)
fi

# --- Delta from previous row ---
TOKENS_DELTA_K=0
if [[ -f "$CSV_FILE" ]] && [[ "$TOTAL_TOKENS_K" -gt 0 ]]; then
    LAST_ROW=$(tail -1 "$CSV_FILE")
    LAST_TOTAL=$(echo "$LAST_ROW" | awk -F',' '{print $(NF-1)}')
    if [[ -n "$LAST_TOTAL" && "$LAST_TOTAL" =~ ^[0-9]+$ ]]; then
        TOKENS_DELTA_K=$((TOTAL_TOKENS_K - LAST_TOTAL))
    fi
fi

# --- Write CSV ---
HEADER="timestamp,openai_hourly_usage,openai_hourly_pct,openai_hourly_reset,openai_weekly_pct,openai_weekly_reset,session_count,total_tokens_k,tokens_delta_k"

if [[ ! -f "$CSV_FILE" ]]; then
    echo "$HEADER" > "$CSV_FILE"
fi

echo "$TIMESTAMP,$HOURLY_USAGE,$HOURLY_PCT,$HOURLY_RESET,$WEEKLY_PCT,$WEEKLY_RESET,$SESSION_COUNT,$TOTAL_TOKENS_K,$TOKENS_DELTA_K" >> "$CSV_FILE"
