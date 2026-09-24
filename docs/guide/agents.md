# Your PADs

A PAD is one AI helper running in its own box. The **Agents** page lists all of yours as cards: green means running, grey means stopped.

## Open a PAD

Click any card. The agent page has tabs across the top — Commands, Workspace, Config, Web & Ports, Logs, Activity, Settings — and a terminal docked at the bottom.

## Start, stop, restart

- On the Agents page, each card has **Start**, **Stop**, and **Restart** buttons.
- Stopping a PAD is safe. It keeps all its files. Starting brings it back exactly as it was.
- Only stopping deletes nothing. To remove a PAD forever, open it, go to **Settings**, and use **Delete** (it asks you to confirm first).

## The tabs in plain words

| Tab | What it is for |
|---|---|
| Commands | Buttons for common tasks — start here |
| Workspace | Your helper's files — view, edit, upload |
| Config | Its settings file — change carefully |
| Web & Ports | Put its web page online, expose SSH |
| Logs | What the box has been saying |
| Activity | Timeline of what happened |
| Settings | Big changes: rebuild, move, delete |

## See Also

- [Getting started](getting-started.md) — create your first PAD
- [The terminal](terminal.md) — type commands yourself
- [Technical detail: Agent tabs overview](/reference/tabs/overview) — every tab and its API, for readers who want depth
