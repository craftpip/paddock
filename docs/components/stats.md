# Stats (Sidebar)

Live Docker resource usage visible in the sidebar of any PAD detail page. Not a separate tab.

## What's shown

- **CPU** — percentage, always visible
- **MEM** — memory usage with unit, always visible
- **Network I/O** — hover to reveal (RX/TX)
- **Disk I/O** — hover to reveal

## Data source

```
docker stats --no-stream --format "{{json .}}"
```

Fetched via `GET /api/agents/:name/stats` every 3 seconds while the agent is running. Stops polling when agent is not running.

## Component

File: `src/client/src/pages/AgentDetail.jsx` — `SidebarStatus` function, stats section (lines 69-94). Hover tooltip for network + disk I/O (lines 82-93).
