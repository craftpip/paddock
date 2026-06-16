#!/bin/bash
# Usage Budget — shows current OpenAI usage, burn rate, and headroom
set -euo pipefail

CONTAINER="vm-ozden"
CSV="/home/boniface/www/vm-friends/usage_data.csv"

python3 << 'PYEOF'
import json, subprocess, os, csv
from datetime import datetime, timezone

container = "vm-ozden"
csv_file = "/home/boniface/www/vm-friends/usage_data.csv"

# --- Fetch live usage from openclaw status --usage --json ---
live = {}
for attempt in range(2):
    try:
        raw = subprocess.check_output(
            ["docker", "exec", container, "openclaw", "status", "--usage", "--json"],
            stderr=subprocess.STDOUT, timeout=30
        )
        data = json.loads(raw)
        for prov in data.get("usage", {}).get("providers", []):
            if prov.get("provider") == "openai":
                live["plan"] = prov.get("plan") or "unknown"
                error = prov.get("error")
                if error:
                    break
                for w in prov.get("windows", []):
                    label = w.get("label", "")
                    if label == "5h":
                        live["hourly_left"] = 100 - w.get("usedPercent", 0)
                        live["hourly_reset_ts"] = w.get("resetAt", 0)
                    elif label == "Week":
                        live["weekly_left"] = 100 - w.get("usedPercent", 0)
                        live["weekly_reset_ts"] = w.get("resetAt", 0)
        if "weekly_left" in live:
            break
    except Exception:
        pass

# Fallback to last CSV row if live fetch failed
if "weekly_left" not in live and os.path.exists(csv_file):
    try:
        with open(csv_file) as f:
            rows = list(csv.DictReader(f))
        last = None
        for r in reversed(rows):
            w = r.get("weekly_pct_left", "").strip()
            if w and w.isdigit():
                last = r
                break
        if last:
            live.setdefault("weekly_left", int(last["weekly_pct_left"]))
            live.setdefault("hourly_left", int(last.get("hourly_pct_left", "0") or "0"))
            live.setdefault("plan", last.get("plan", "unknown"))
    except Exception:
        pass

# --- Fetch session breakdown ---
sessions_data = {"direct": 0, "cron": 0, "telegram": 0, "other": 0}
total_tokens = 0
try:
    raw = subprocess.check_output(
        ["docker", "exec", container, "openclaw", "sessions", "list", "--json"],
        stderr=subprocess.STDOUT, timeout=30
    )
    for s in json.loads(raw).get("sessions", []):
        t = s.get("totalTokens")
        if not isinstance(t, (int, float)) or t != t:
            t = 0
        t = int(t)
        total_tokens += t
        key = s.get("key", "") or ""
        kind = s.get("kind", "") or ""
        if "telegram" in key:
            sessions_data["telegram"] += t
        elif kind == "cron":
            sessions_data["cron"] += t
        elif kind == "direct":
            sessions_data["direct"] += t
        else:
            sessions_data["other"] += t
except Exception:
    pass
sessions_data["total"] = total_tokens

# --- Read CSV history for burn rate ---
weekly_vals = []
prev_weekly_left = None
prev_ts = None
try:
    with open(csv_file) as f:
        reader = csv.DictReader(f)
        for row in reader:
            w = row.get("weekly_pct_left", "").strip()
            ts_str = row.get("timestamp", "").strip()
            if w and w.isdigit() and ts_str:
                try:
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                    val = int(w)
                    if prev_weekly_left is not None and prev_ts is not None:
                        hours = (ts - prev_ts).total_seconds() / 3600
                        if 0 < hours < 72:
                            drop = prev_weekly_left - val
                            if drop > 0:
                                weekly_vals.append((hours, drop, drop / hours))
                    prev_weekly_left = val
                    prev_ts = ts
                except:
                    pass
except Exception:
    pass

# --- Calculate burn rate ---
burn_rate_per_h = 0
if weekly_vals:
    burn_rate_per_h = sum(r for _, _, r in weekly_vals) / len(weekly_vals)

def format_timedelta(td):
    total = int(td.total_seconds())
    if total < 0:
        return "now"
    days = total // 86400
    hours = (total % 86400) // 3600
    mins = (total % 3600) // 60
    parts = []
    if days: parts.append(f"{days}d")
    if hours: parts.append(f"{hours}h")
    if mins: parts.append(f"{mins}m")
    return " ".join(parts) if parts else "<1m"

# --- Determine reset time ---
now = datetime.now(timezone.utc)
weekly_left = live.get("weekly_left", 0)
hourly_left = live.get("hourly_left", 0)
weekly_reset_ts = live.get("weekly_reset_ts", 0)
plan = live.get("plan", "")

if weekly_reset_ts:
    reset_dt = datetime.fromtimestamp(weekly_reset_ts / 1000, tz=timezone.utc)
    reset_in = reset_dt - now
    reset_hours = reset_in.total_seconds() / 3600
    reset_str = format_timedelta(reset_in)
else:
    reset_hours = 0
    reset_str = "unknown"

# --- Projection ---
projected_at_reset = weekly_left
if burn_rate_per_h > 0 and reset_hours > 0:
    projected_at_reset = weekly_left - (burn_rate_per_h * reset_hours)

hours_until_empty = weekly_left / burn_rate_per_h if burn_rate_per_h > 0 else 999

# --- Bar ---
bar_len = 30
filled = max(0, min(bar_len, int(weekly_left / 100 * bar_len)))
bar = "█" * filled + "░" * (bar_len - filled)

# --- Output ---
print()
print("  📊 Usage Budget (vm-ozden)")
print("  ─────────────────────────")
print(f"  Provider:    OpenAI {plan}")
print(f"  Weekly:      {bar}")
print(f"  Remaining:   {weekly_left}%  ·  resets {reset_str}")
print(f"  Hourly:      {hourly_left}% left")
print()

if burn_rate_per_h > 0:
    print(f"  Burn rate:   {burn_rate_per_h:.1f}%/hour ({burn_rate_per_h*24:.1f}%/day)")
    if projected_at_reset > 0:
        print(f"  Projected:   ~{projected_at_reset:.0f}% left at reset ✅")
    else:
        print(f"  Projected:   will hit 0% ~{hours_until_empty:.0f}h before reset ⚠️")
    if 0 < hours_until_empty < 999:
        print(f"  Runway:      ~{hours_until_empty:.0f}h at current pace")
else:
    print("  Burn rate:   not enough data yet (need 2+ readings)")
print()

# --- Context breakdown ---
if total_tokens > 0:
    print(f"  Session context ({total_tokens:,} total tokens):")
    for label, key in [("💬 Direct", "direct"), ("🔧 Cron", "cron"), ("📨 Telegram", "telegram"), ("📌 Other", "other")]:
        val = sessions_data.get(key, 0)
        if val:
            pct = val / total_tokens * 100
            bar = "█" * max(1, int(pct / 4)) + "░" * (25 - max(1, int(pct / 4)))
            print(f"    {label:>14}: {val:>8,} ({pct:5.1f}%) {bar}")
    print()

# --- Headroom estimate ---
if weekly_left > 0 and total_tokens > 0:
    # Rough estimate: current total tokens represent (100 - weekly_left)% of weekly cap
    weekly_cap = total_tokens / ((100 - weekly_left) / 100)
    remaining_tokens = weekly_cap - total_tokens
    print(f"  💡 Estimated weekly cap:  ~{weekly_cap:,.0f} tokens")
    print(f"     Headroom remaining:    ~{remaining_tokens:,.0f} tokens")
    print()

print()
PYEOF
