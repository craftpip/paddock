# Optimization Plan — `trading:nifty-monday-check`

## Overview

Cron job ID: `de2dd6c8-24fc-413c-887e-39af0824fc52`
Schedule: `0 11 * * 1 @ Asia/Calcutta` (Mon 11:00 AM IST)
Agent: `dev` | Model: `openai/gpt-5.5` | Session: `isolated`
Delivery: Telegram announce → `7283352340`
Prompt: sends `"NIFTY"` — triggers full live-trade workflow

## Observed Run Durations

| Run | Date | Duration | Input Tokens | Output Tokens | Total Tokens |
|-----|------|----------|-------------|--------------|-------------|
| 1 | Jun 23 (Mon 11 AM) | **64s** | 17,411 | 360 | 41,195 |
| 2 | Jun 15 (Mon 11 AM) | **117s** | 17,192 | 1,179 | 56,131 |
| 3 | Jun 13 (Sat manual) | **65s** | 7,790 | 347 | 34,633 |
| 4 | Jun 8 (Mon manual) | **133s** | 12,163 | 756 | 58,115 |

All 4 runs resulted in **NO TRADE / SKIP**.

## Detailed Tool Call Timeline (64s run — Jun 23)

All timestamps in UTC from `trajectory.jsonl`.

| Time (UTC) | Elapsed | Duration | Event |
|------------|---------|----------|-------|
| 08:18:55.981 | 0s | — | Session started |
| 08:18:55.990 | 0.01s | — | Prompt submitted: `"NIFTY"` |
| 08:19:08.423 | **+12.4s** | **12.4s** | **Model thinking** → decides to read SKILL.md |
| 08:19:08.426 | — | 0ms | bash `sed` SKILL.md (instant) |
| 08:19:17.755 | **+9.3s** | **9.3s** | **Model thinking** → decides to read source-order.md |
| 08:19:17.758 | — | 0ms | bash `sed` source-order.md (instant) |
| 08:19:30.453 | **+12.7s** | **12.7s** | **Model thinking** → decides to screenshot NSE |
| 08:19:32.748 | — | **2,294ms** | `web_page_screenshot` of nseindia.com |
| 08:19:46.784 | **+14.0s** | **14.0s** | **Model thinking** → decides to extract page text |
| 08:19:46.817 | — | **28ms** | `web_open_page` of same URL |
| 08:19:55.675 | **+8.9s** | **8.9s** | **Model thinking** → final analysis "NO TRADE" |
| 08:19:55.678 | — | — | Session ended |

**Actual tool execution: ~2.3s (screenshot) + 0.03s (page text) = ~2.3s**
**Model thinking time: ~57.3s** (89.5% of total runtime)

## Root Cause

**The web tools are NOT slow.** The bottleneck is **model thinking time**:
- gpt-5.5 takes **9–14 seconds per thinking turn** (deciding which tool to call next)
- Each bash/web tool call adds a full thinking round
- Longer runs add more rounds (extra skill reads, `date`, `rg`, curl, web searches for events)

## Wasted Tool Calls (found in longer runs)

- `bash date` — confirms date already in the prompt
- `bash rg` searching for screenshot instructions — re-reads files already loaded
- `bash mkdir + cp + file` — `file` command not found → error → recovery
- `bash curl` to NSE API — returns "Resource not found" → wasted
- `web_search` for RBI calendar / events — adds 2-3 extra think rounds

## Optimization Ideas

### 1. Inline the skill into the system prompt
- SKILL.md is ~240 lines loaded every run via bash `sed`
- Agent wastes 12s reading it + 9s reading source-order.md
- **Save: ~21s** by trimming or baking into agent instructions

### 2. Eliminate redundant NSE fetch
- Workflow does screenshot THEN page text on same URL
- If screenshot succeeds with readable data, skip page text
- **Save: ~14s** (one thinking round)

### 3. Skip screenshot copy/move for analysis
- SKILL.md says "copy to /media/" but the agent never calls image analysis
- The `file` command to verify copy fails anyway
- **Save: ~9-14s** (the thinking round for this + error handling)

### 4. Reduce event/web search
- The prompt already includes "Current time: Monday..." with full date
- Web searching for "RBI policy June 2026" every time is wasteful
- **Save: ~25-40s** per run

### 5. Faster model
- gpt-5.5 takes 9-14s per think turn. A faster/cheaper model could cut this significantly
- Since all runs return NO TRADE, a lower-latency model is fine

## Estimated Savings

| Optimization | Time Saved | Cumulative |
|-------------|-----------|------------|
| Inline skill + trim reference reads | ~21s | **~43s** |
| Skip redundant page text | ~14s | **~29s** |
| Skip screenshot copy/move | ~14s | **~15s** |
| Skip event web search | ~25s | - |

With all optimizations: **~10-15s per run** (from 64-133s).

## Agent Instructions (for reference)

The agent has these instruction files in workspace-dev:
- `USER.md` — user preferences
- `MEMORY.md` — procedural memory (screenshot handling, web search rules)
- `BOOTSTRAP.md` — startup instructions
- `skills/live-trade-decision/SKILL.md` — main workflow (~240 lines)
- `skills/live-trade-decision/references/source-order.md` — source selection
- `skills/option-chain-reader/SKILL.md` — option chain reading

The cron job message is simply: `"NIFTY"` — the entire workflow is triggered by the skill.

## Files Involved

```
instances/vm-ozden/openclaw/
  cron/                          # Cron job storage (SQLite)
  agents/dev/
    sessions/1544a75c-*.trajectory.jsonl    # Tool trace
    sessions/1544a75c-*.jsonl               # Full session log
    agent/                                   # Agent config dir
      codex-home/.openclaw/workspace-dev/   # Agent workspace
        USER.md
        MEMORY.md
        BOOTSTRAP.md
        skills/live-trade-decision/SKILL.md
        skills/live-trade-decision/references/source-order.md
        skills/option-chain-reader/SKILL.md
        skills/option-chain-reader/references/sources.md
```
