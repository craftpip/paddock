# Stats (Header)

Live Docker resource usage visible in the top header bar of any PAD detail page. Not a separate tab.

> Last updated: 2026-08-17

## What's shown

- **CPU** — percentage, always visible
- **MEM** — memory usage with unit, always visible

## Data source

```
docker stats <runtime_ref> --no-stream --format "{{json .}}"
```

Fetched via `GET /api/agents/:name/stats` every 3 seconds while the agent is
running. Stops polling when the agent is not running. The response is the raw
`docker stats` JSON object (`{ CPUPerc, MemUsage, NetIO, BlockIO, ... }`).

`GET /api/agents/stats/fleet` returns the same for all running project
containers (`{ stats }`) — currently unused by the SPA.

## Component

File: `src/client/src/pages/AgentDetail.jsx` — `AgentHeader` (stats state,
3s poll, CPU/MEM lines). Renders in a horizontal top header bar above the mode
tabs, not in a sidebar.
