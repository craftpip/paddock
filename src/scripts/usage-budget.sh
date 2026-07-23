#!/bin/bash
# Usage Budget — shows current OpenAI usage, burn rate, and headroom
set -euo pipefail

CONTAINER="vm-jake"
CSV="/home/boniface/www/vm-friends/usage_data.csv"

show_help() {
    cat << 'HELP'
Usage: ./scripts/usage-budget.sh [options]

Options:
  -h, --help       Show this help message and exit
  -c, --compact    Show compact output (day + 3h block + position per reading)

Without options, shows the full usage budget dashboard.
HELP
    exit 0
}

COMPACT=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) show_help ;;
        -c|--compact) COMPACT=1 ;;
        *) echo "Unknown option: $1"; show_help ;;
    esac
    shift
done

export COMPACT

python3 << 'PYEOF'
import json, subprocess, os, csv, re
from datetime import datetime, timezone, timedelta

container = "vm-jake"
csv_file = "/home/boniface/www/vm-friends/usage_data.csv"
compact = os.environ.get("COMPACT", "0") == "1"

# --- Fetch live usage from openclaw status --usage --json ---
def window_hours(label):
    text = (label or "").strip().lower()
    if text == "week":
        return 168
    match = re.fullmatch(r"(\d+)\s*h", text)
    if match:
        return int(match.group(1))
    return None

live = {}
for attempt in range(2):
    try:
        raw = subprocess.check_output(
            ["docker", "exec", container, "openclaw", "status", "--usage", "--json"],
            stderr=subprocess.STDOUT, timeout=30
        )
        text = raw.decode()
        brace = text.find("{")
        data = json.loads(text[brace:] if brace >= 0 else text)
        for prov in data.get("usage", {}).get("providers", []):
            if prov.get("provider") == "openai":
                live["plan"] = prov.get("plan") or "unknown"
                error = prov.get("error")
                if error:
                    break
                hourly_window = None
                weekly_window = None
                for w in prov.get("windows", []):
                    hours = window_hours(w.get("label", ""))
                    if hours is None:
                        continue
                    if hours <= 6 and (hourly_window is None or hours < hourly_window[0]):
                        hourly_window = (hours, w)
                    if hours >= 24 and (weekly_window is None or hours > weekly_window[0]):
                        weekly_window = (hours, w)
                if hourly_window:
                    w = hourly_window[1]
                    live["hourly_left"] = 100 - w.get("usedPercent", 0)
                    live["hourly_reset_ts"] = w.get("resetAt", 0)
                if weekly_window:
                    w = weekly_window[1]
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
            reset_at = (last.get("weekly_reset_at", "") or "").strip()
            if reset_at:
                try:
                    live.setdefault("weekly_reset_ts", int(datetime.fromisoformat(reset_at.replace("Z", "+00:00")).timestamp() * 1000))
                except Exception:
                    pass
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
breakdown_data = []
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
                                rate = drop / hours
                                weekly_vals.append((hours, drop, rate))
                                ts_local = ts.astimezone(timezone(timedelta(hours=5, minutes=30)))
                                dow = ts_local.weekday()
                                hour_local = ts_local.hour
                                block_start = (hour_local // 3) * 3
                                block_label = f"{block_start:02d}-{block_start+3:02d}"
                                breakdown_data.append((dow, hour_local, block_label, rate))
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
print("  📊 Usage Budget (vm-jake)")
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

# --- Breakdown by day and hour ---
if breakdown_data:
    dow_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    block_labels = [f"{h:02d}-{h+3:02d}" for h in range(0, 24, 3)]

    if compact:
        now_local = datetime.now(timezone(timedelta(hours=5, minutes=30)))
        cur_dow = now_local.weekday()
        cur_hour = now_local.hour
        block_start = (cur_hour // 3) * 3
        cur_block = f"{block_start:02d}-{block_start+3:02d}"
        cur_rates = [r for d, _, b, r in breakdown_data if d == cur_dow and b == cur_block]
        avg_rate = sum(cur_rates) / len(cur_rates) if cur_rates else 0
        print(f"  📍 Now: {dow_names[cur_dow]}  {cur_block}  —  avg burn {avg_rate:.2f}%/h  ({len(cur_rates)} readings)")
        print()
    else:
        dow_rates = {d: [] for d in range(7)}
        block_rates = {b: [] for b in block_labels}
        dow_block_rates = {(d, b): [] for d in range(7) for b in block_labels}

        for dow, hour, block, rate in breakdown_data:
            dow_rates[dow].append(rate)
            block_rates[block].append(rate)
            dow_block_rates[(dow, block)].append(rate)

        # Day × 3h block matrix
        print("  📊 Burn rate breakdown")
        print()
        print("  Day × 3h block (IST, %/h):")
        print(f"  {'Day':<6}  " + "  ".join(f"{b:>6}" for b in block_labels))
        print(f"  {'─'*6}  " + "  ".join("──────" for _ in block_labels))
        for d in range(7):
            cells = []
            for b in block_labels:
                r = dow_block_rates[(d, b)]
                avg_r = sum(r) / len(r) if r else None
                cells.append(f"{avg_r:>6.2f}" if avg_r is not None else "     -")
            print(f"  {dow_names[d]:<6}  " + "  ".join(cells))
        print()

        # By day of week
        print("  By day of week:")
        for d in range(7):
            r = dow_rates[d]
            if r:
                a = sum(r) / len(r)
                print(f"    {dow_names[d]:>3}:  {a:.2f}%/h  ({len(r)} reading{'s' if len(r)!=1 else ''})")
            else:
                print(f"    {dow_names[d]:>3}:  no data")
        print()

        # By 3h block
        print("  By 3h block (IST):")
        for b in block_labels:
            r = block_rates[b]
            if r:
                a = sum(r) / len(r)
                print(f"    {b:>5}:  {a:.2f}%/h  ({len(r)} reading{'s' if len(r)!=1 else ''})")
            else:
                print(f"    {b:>5}:  no data")
        print()

print()
PYEOF
