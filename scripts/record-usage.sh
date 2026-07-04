#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CSV_FILE="$PROJECT_DIR/usage_data.csv"
CONTAINER="vm-jake"

python3 << 'PYEOF'
import json, subprocess, os, csv
from datetime import datetime, timezone

csv_file = "/home/boniface/www/vm-friends/usage_data.csv"
container = "vm-jake"
ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

HOURLY_PCT = ""
HOURLY_RESET = ""
WEEKLY_PCT = ""
WEEKLY_RESET = ""
PLAN = ""
TOTAL_TOKENS_K = 0

def ms_to_readable(ms):
    """Convert Unix ms timestamp to human-readable 'Xh Ym' or 'Xd Yh'."""
    if not ms:
        return ""
    try:
        reset_dt = datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc)
        now = datetime.now(timezone.utc)
        diff = reset_dt - now
        total_s = int(diff.total_seconds())
        if total_s < 0:
            return "now"
        days = total_s // 86400
        hours = (total_s % 86400) // 3600
        mins = (total_s % 3600) // 60
        parts = []
        if days: parts.append(f"{days}d")
        if hours: parts.append(f"{hours}h")
        if mins: parts.append(f"{mins}m")
        return " ".join(parts) if parts else "<1m"
    except:
        return ""

# --- Fetch usage from openclaw status --usage --json (with retry) ---
for attempt in range(2):
    try:
        raw = subprocess.check_output(
            ["docker", "exec", container, "openclaw", "status", "--usage", "--json"],
            timeout=30
        )
        # Strip any non-JSON prefix (e.g. [state-migrations] warnings on stderr)
        text = raw.decode()
        brace = text.find("{")
        data = json.loads(text[brace:] if brace >= 0 else text)
        for prov in data.get("usage", {}).get("providers", []):
            if prov.get("provider") == "openai":
                PLAN = prov.get("plan") or ""
                if prov.get("error"):
                    break
                for w in prov.get("windows", []):
                    label = w.get("label", "")
                    used = w.get("usedPercent", 0)
                    reset = w.get("resetAt", 0)
                    if label == "5h":
                        HOURLY_PCT = str(100 - used)
                        HOURLY_RESET = ms_to_readable(reset)
                    elif label == "Week":
                        WEEKLY_PCT = str(100 - used)
                        WEEKLY_RESET = ms_to_readable(reset)
        if WEEKLY_PCT:
            break
    except Exception:
        pass

# --- Get session tokens from openclaw sessions list --json ---
try:
    raw = subprocess.check_output(
        ["docker", "exec", container, "openclaw", "sessions", "list", "--json"],
        stderr=subprocess.STDOUT, timeout=30
    )
    total = 0
    for s in json.loads(raw).get("sessions", []):
        t = s.get("totalTokens")
        if isinstance(t, (int, float)) and t == t:
            total += int(t)
    TOTAL_TOKENS_K = total
except Exception:
    pass

# --- Delta from previous row ---
TOKENS_DELTA_K = 0
if os.path.exists(csv_file) and TOTAL_TOKENS_K > 0:
    try:
        with open(csv_file) as f:
            rows = list(csv.DictReader(f))
        if rows:
            last = rows[-1].get("total_tokens_k", "0")
            if last and last.isdigit():
                TOKENS_DELTA_K = TOTAL_TOKENS_K - int(last)
    except Exception:
        pass

# --- Write CSV (compatible format) ---
HEADER = "timestamp,hourly_usage,hourly_pct_left,hourly_reset_in,weekly_pct_left,weekly_reset_in,total_tokens_k,tokens_delta_k,plan"

needs_header = not os.path.exists(csv_file)
with open(csv_file, "a") as f:
    if needs_header:
        f.write(HEADER + "\n")
    # hourly_usage is left empty (we track pct_left instead)
    row = f"{ts},,{HOURLY_PCT},{HOURLY_RESET},{WEEKLY_PCT},{WEEKLY_RESET},{TOTAL_TOKENS_K},{TOKENS_DELTA_K},{PLAN}"
    f.write(row + "\n")
PYEOF
