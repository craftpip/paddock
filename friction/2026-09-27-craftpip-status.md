# Chat Test — Status Sweep: "list open sessions" + "what's happening with craftpip?"

**Date:** 2026-09-27
**Mode:** chat test (MCP only — no shell, no API, no backend code)
**Task:** "list all the sessions that are open" and, separately, "what is
happening with my project craft pip?"

Outcome: the session list is answerable but only after I guessed that
"session" means "container with status running". **craftpip is a blocker** — it
is not a PAD and the surface has exactly one window onto non-PAD containers, and
that window is truncated. I stopped rather than fall back to `docker`.

## Findings

### `create_agent` cannot create a `claude` pad, but three other tools say claude is supported

- **Tool:** `create_agent` + `help` + `agent_commands` + `list_agents`
- **Severity:** blocker
- **What I asked:** nothing yet — the first two calls of the session were `help`
  and `list_agents`.
- **What happened:** `help` says each PAD runs an agent "of a type — openclaw,
  opencode, picoclaw, hermes, **codex, or claude**". `agent_commands` accepts
  `claude` as its `type`. `list_agents` shows a live pad `pad-test-claude` with
  `agent_type: "claude"`. But `create_agent`'s `agent` enum is
  `openclaw | opencode | picoclaw | hermes | codex` — claude is absent. I cannot
  create the one agent type the system visibly has running.
- **Why it hurts:** three tools say claude is first-class; the one tool that
  spawns pads says no. A caller reads the enum, concludes claude is
  deprecated or experimental, and never tries — or assumes `codex` and stops
  noticing. The running `pad-test-claude` is the only evidence claude works,
  and nothing in the surface connects that evidence to the create path.
- **Fix:** add `"claude"` to the `create_agent` `agent` enum. If it is
  deliberately unsupported, drop claude from the `help` type list and from
  `agent_commands`.
- **Status (2026-09-29):** NOT addressed by plan 61 — it is outside that plan's
  scope, and confirming it needs a real `create_agent {agent: "claude"}` (an
  image build on the user's fleet) to prove the path works rather than merely
  un-breaks the schema. The `claude` driver does exist
  (`services/drivers/claude`) and `pad-test-claude` is running, so the omission
  looks like a plain oversight. Needs its own plan or the user's go-ahead.
- **Still open (2026-09-29, unchanged):** `create_agent`'s `agent` enum is still
  `openclaw | opencode | picoclaw | hermes | codex`. Everything that made this a
  blocker instead of a curiosity is still true, and one more tool now agrees:
  - `help`: *"openclaw, opencode, picoclaw, hermes, codex, or claude"*
  - `agent_commands {type: "claude"}` → a full catalog (Status, Auth, Session, MCP,
    Plugin, Other) plus 6 `notUsable` entries
  - `list_agents`: `pad-test-claude`, `agent_type: "claude"`, `status: "running"`
  - `mission_projects.supportedAgentTypes`: `["opencode", "codex", "claude"]`
  - `plan_list {agent: "pad-test-claude"}` works (`plansFolder:
    "/workspace/instances/pad-test-claude/claude/workspace/plans"`), so the
    facility treats a claude pad as fully first-class.

  The enum is the only thing in the surface that says claude cannot be created.
  It has now survived three sessions' worth of attention and is a one-word fix.

### A container that is not a PAD is completely invisible — craftpip is unanswerable

- **Tool:** `list_agents` + `get_agent` + `health` + `settings_get`
- **Severity:** blocker
- **What I asked:** "What is happening with my project craft pip?"
- **What happened:** craftpip is in no fleet listing. `get_agent {name:
  "craftpip"}` → `MCP error -32600: Agent not found: craftpip`. `health {name:
  "craftpip"}` → the identical error. The only place a non-PAD container is
  visible anywhere in the tool surface is the `availableNetworks` block nested
  inside some *other* pad's `settings_get`. There is no `list_containers`, no
  way to look up a container by name, no logs, no ports, no state.
- **Why it hurts:** the question is entirely reasonable — craftpip is a real
  running project container — and the surface answers it with nothing. The
  caller cannot even confirm craftpip *exists*, let alone whether it is up,
  restarting, or wedged. The error text is honest ("Agent not found") but it
  collapses two different situations: a typo'd pad name and a real non-pad
  container produce the same answer, so the caller is left guessing which one
  they are in.
- **Fix:** one read tool that lists host containers with `name`, `image`,
  `state`, and (optionally) published ports — e.g. `list_containers`. Failing
  that, have `get_agent`/`health` distinguish the two cases in the error:
  "no such PAD (a container named craftpip does exist on the host — see
  availableNetworks)".
- **Note:** this compounds the earlier `availableNetworks` finding below. The
  prior fix made that field quiet; the cap is what makes it a blocker now.
- **Resolution (2026-09-29, plan 61):** partly fixed. The near-miss half is
  done: a name that IS a real host container but not a PAD is no longer reported
  as missing, it is named as such. Verified live: `get_agent {name:"schlorp"}` →
  `"schlorp" IS a container on this host, but it is not a Paddock-managed PAD (no
  instances/schlorp/meta.env). Paddock cannot open it — create a PAD for it if you
  want to work in it.`, which is now distinguishable from a typo. **Still open: the
  `list_containers` tool itself**, which would let a caller look a container up
  rather than only recognise one they already named — not added without the
  human's approval, so ask.

### The `availableNetworks` cap hides the very container a caller asked about

- **Tool:** `settings_get`
- **Severity:** blocker
- **What I asked:** indirectly — I was looking for any trace of craftpip and
  fell back to the only field that lists non-PAD containers.
- **What happened:** `availableNetworks` returned 10 entries —
  `gluetun-nordvpn1`, `navigator`, `gluetun-nordvpn2`, `pad-openclaw-cp`,
  `jellysort`, `bedrock-bedrock`, `schlorp`, `torra`, `qbittorrent`,
  `gluetun-proton1` — with `availableNetworksTotal: 46` and
  `availableNetworksTruncated: true`. craftpip is one of the 36 not shown. The
  ten that *are* shown are dominated by four gluetun VPN containers, so the
  cap is spent on near-duplicates while a project container the caller named is
  unreachable.
- **Why it hurts:** truncation is honestly flagged, which is good, but a flag
  does not help when the caller needs a *specific* name. The previous session's
  finding recorded craftpip as visible in this list; the fix that capped the
  list at 10 made it invisible. A cap is the right call for a suggestion list
  and the wrong call for a lookup — and nothing in the field says which one it
  is. It is called `availableNetworks`, documented as "network peer container to
  route through", and is the fleet's only non-PAD window, so a caller with a
  named container in hand has to know to look here.
- **Fix:** keep the cap for the peer *picker*, and make the field searchable —
  accept a `networkFilter` (name substring) on `settings_get` so a caller who
  knows the name gets it back instead of ten arbitrary entries. Second-cheapest
  fix: sort so non-gluetun, project-like containers come first rather than four
  identical VPN images.
- **Prior finding:** this extends `2026-09-27-clone-proj.md` →
  "`settings_get` returns the whole host's container list", whose Resolution
  capped the list at 10. That Resolution fixed the noise and created this.
- **Resolution (2026-09-29, plan 61):** fixed. `settings_get` takes an optional
  `networkFilter`, which searches the whole peer list rather than the first 10 and
  returns `availableNetworksSearchedAll: true`, so an empty result means "no such
  peer" instead of being indistinguishable from a truncated list. Verified live:
  `networkFilter: "gluetun"` → all 3 gluetun peers, `isCurrent` correct. **The
  diagnosis was partly wrong:** `pad-proj2` is not hidden by the cap at all — a
  fleet pad that publishes no ports is excluded on purpose. The cap was never the
  cause for that pad; the searchable field is the fix that makes a named lookup
  reliable either way. The default list is still capped at 10.
