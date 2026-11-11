# PAD Lifecycle Rules

The rules the create, change, delete, status and health paths of a PAD (one agent instance:
`instances/<name>/` plus its `pad-*` container) hold to, and the reason for each. It is for
anyone changing `src/services/vm-manager/`, `agent-registry.js` or `container-health.js`, or
reading a status or a health row and deciding what to do about it.

Function-by-function listings are in [Backend Services](services.md); the operator's view of
the same flows is in [Operations](../operations/overview.md).

## Status of a PAD

`agent-registry.js` builds every PAD's `status` from one listing,
`docker ps -a --format "{{.Names}}\t{{.State}}"` (`dockerPsList`).

| Status | Source | Means |
|---|---|---|
| `running`, `exited`, `created`, `paused`, `restarting`, `removing`, `dead` | docker | The container's state as docker reports it |
| `starting`, `stopping`, `restarting` | the webui | A start, stop, restart or change set is in flight (`setLifecycle`); it overrides the docker state until the command returns |
| `missing` | docker | The listing succeeded and has no container of that name |
| `unknown` | the webui | Docker could not be asked: the listing failed or timed out |

`missing` and `unknown` are different answers because they call for different actions.
`missing` is a reason to recreate the PAD. `unknown` says nothing about the PAD, which is very
likely still running; the client shows it as a warning pill (`src/client/src/lib/status.js`),
not as the grey `missing` one.

### A Failed Listing

- A successful listing is cached for 3 seconds (`DOCKER_CACHE_TTL`).
- When the listing fails, the last good answer stands in for it only while it is younger than
  30 seconds (`STALE_OK_MS`). After that the result carries a failure mark and every PAD
  without a lifecycle override reads `unknown`.
- `discoverAgents` does not write to the `agents` table when the listing failed. The recorded
  status stays what it was; a guess never replaces a true `running`.

### Fleet Counts

`GET /api/agents` passes the list `discoverAgents` just returned to `getAgentStats`, so
`total`, `running` (`running`), `stopped` (`exited`) and `unknown` (everything else) count the
PADs that exist on disk: a directory under `instances/` with a valid name and a `meta.env`.
A row left in the database by a PAD whose directory is gone is not counted, and the orphan
count is taken over the same list. Counting database rows remains only as the fallback for a
caller that passes no list.

## Creating a PAD

`createAgent` (the path behind `POST /api/agents` and the MCP `create_agent` tool) validates
the whole request before it makes anything: name, agent type, network peer, workspace mount,
extra volumes and ports, host-port conflicts and the web publish request
(`validateAgentCreate`). `createVm` then refuses a root password that contains a line break or
NUL or is longer than 256 characters (`assertRootPassword`) and an SSH host port that is not a
number from 1 to 65535 (`assertPort`). Both values are written to `meta.env`, where a line
break would start a second variable.

When a create fails part-way, `removeFailedCreate` removes what that attempt made: the
container, `<name>-door` and `<name>-web`, the `<name>_default` network, the instance
directory and the per-PAD image. The name is free to use again. Two limits:

- It runs only when `instances/<name>/` did not exist before the attempt.
- It never removes the workspace source. Only the delete of a PAD that was created
  successfully may do that.

## Changing a PAD

Every change to an existing PAD goes through `applyAgentChanges` in
`vm-manager/settings-apply.js`: the settings, web, ports and recreate routes and the MCP
`recreate` tool. The step order is in
[Backend Services](services.md#vm-manager-servicesvm-manager).

### One Change Set per PAD

One change runs per PAD at a time. `settings-apply.js` holds an in-memory lock per PAD name:
`claimPadChange(name)` takes it or throws, `releasePadChange(name)` gives it back. A second
claim for the same PAD while one is held starts nothing and throws:

| Field | Value |
|---|---|
| `code` | `pad_change_in_progress` |
| `status` | `409` |
| `message` | `Another change is being applied to <name>. Wait for it to finish, then try again.` |

Two interleaved applies would each rewrite `meta.env` and the compose file and run
`compose up`. A change to a different PAD is never held up.

**The lock is claimed at the door.** Every caller claims it before it answers and before it
touches the job log:

| Caller | Refusal |
|---|---|
| `POST /api/agents/:name/settings`, `/web`, `/ports`, `/recreate` | `409` with `{ error, code: "pad_change_in_progress" }` |
| `POST /api/agents/:name/update` | the same `409` |
| MCP `recreate`, MCP `update` | a tool error: `<message> (code: pad_change_in_progress)` |

All of these share the `update:<name>` job. Claiming before `getOrCreateJob` is what keeps a
refused request away from it: a request refused later, inside the background work, would
already hold the first request's job, mark that running job failed and clear the PAD's
`restarting` state.

The claim comes after validation, so an invalid request is still a `400` and a request that
changes nothing still answers without a job. An accepted REST request answers `202` and runs in
the background; the lock is released when that work ends, whether it succeeded or failed.

The update path (`updateAgent`: rebuild the image, then recreate) takes the same lock, so an
update and a settings change cannot interleave either. `applyAgentChanges` called with
`claimed: true` uses the caller's claim; called without it, it claims the lock itself.

Delete takes the same lock (see [Deleting a PAD](#deleting-a-pad)).

### What Is Validated First

`prepareAgentChanges` runs before a job is started, so an invalid request is a `400` with the
reason and nothing has been written.

| Input | Rule | Where |
|---|---|---|
| SSH container port | integer, 1 to 65535 | `prepareAgentChanges` |
| SSH / root password | line breaks are stripped; empty keeps the current one | `prepareAgentChanges` |
| Web host port, web container port | number, 1 to 65535 | `prepareAgentChanges` |
| Web password, when it changes | no single quote, backslash, line break or NUL; 256 characters at most | `assertWebPassword` |
| SSH, web and extra host ports | not used by another agent, not used twice by this one | `hostPortInUse`, `validateExtraPorts` |
| Workspace mount, extra volumes | the mount guards | `validateWorkspaceMount`, `validateExtraVolumes` |
| Host-level options | allowed for the caller's role only | `hostPowers.assertAllowed` |

The web password rule exists because the password is written between single quotes in the
PAD's start hook and read back from there; a quote would end the string and run the rest as a
command on every boot. `buildWebHook` applies the same check, so no publish path skips it.

### Values in meta.env

`setMetaFlag(name, key, value)` is the one writer of a single `meta.env` line.

- A value that contains a carriage return, a line feed or NUL throws
  `<KEY>: the value cannot contain a line break`. The file is one `KEY=value` per line, so
  such a value would write a second variable (`EXTRA_VOLUMES`, `HOST_BROWSE`) past every
  guard.
- An empty value removes the line.
- The value is stored verbatim. The replacement is passed as a function, so `$$`, `$&` and
  `$'` in a password are not read as replacement patterns.

### Rollback

When any step of an apply throws, `rollbackAgentChanges` puts back what the apply may have
written, then the original error is thrown. A failure inside the rollback is logged and does
not replace that error.

| Restored | From |
|---|---|
| Build commands, post-create, post-start and post-attach scripts | the pre-change text, when each changed |
| `INSTALL_DOCKER` in `build.env` | the old docker setting, when it changed |
| `web.json` including `authToken`, the web start hook, the agent's web auth | the old binding and password; all three are removed when nothing was published |
| `meta.env` and the compose file | `applySettings` with the old docker, network, workspace, volumes, ports, SSH port, SSH container port and password, plus the old user mode when it changed |
| Forwarding door | removed when the old network was the default, recreated when it was a peer |
| Container | recreated with `compose up --force-recreate` when it was running and the apply had stopped it |

`applyWebAuth` and `removeWebAuth` are awaited in both directions, so a config that cannot be
patched stops the apply with its own reason.

## Health Check

`checkContainerHealth(name)` in `container-health.js` compares what the PAD's compose file
declares (`docker compose config --format json`) with what the container is
(`docker inspect`). It changes nothing; a failing row carries a hint. The report shape and the
Health tab are in [Backend Services](services.md#container-health-container-healthjs) and
[Health tab](../tabs/health.md).

### Three Answers for a Lookup

A container lookup has three outcomes, and so does reading the declaration. Only one of each
is a reason to recreate.

| Question | Answer | Row |
|---|---|---|
| Container | found | checks continue |
| Container | docker says `No such container` / `No such object` | `container`, `error`, `actual: not found` |
| Container | docker could not be asked | `container`, `warn`, `checked: false`, `actual: could not check`; the hint quotes docker and says not to recreate on this result |
| Compose file | resolved | checks continue |
| Compose file | no file | `compose`, `error`; recreate regenerates it |
| Compose file | file exists, does not resolve | `compose`, `warn`, `checked: false`, `actual: could not be read`; the hint quotes the error and says it is not a reason to recreate |

A compose file that exists but does not resolve covers a bad `build.env`, a compose error and
a daemon that did not answer. In both compose cases the declaration-independent rows
(`container`, `health`) are still reported and every comparison row is skipped, because there
is nothing to compare against. `checked: false` marks a row whose question was never answered;
a reader must not treat it as a negative.

### Network Kind Before Peer State

`networkModeDrift(expected, actual)` compares the kind of networking first: does the compose
file declare `network_mode: container:<peer>`, and is the container bound to one? When the
kinds differ in either direction the `network` row is an `error` whose hint ends in
"Recreate to apply the declared networking."

Only when the kinds agree and the declaration is a peer does the row carry the shared peer
verdict from `net-peer.js` (see the network peer section of [Backend Services](services.md)).
The peer classification rules only on a container that is peer-bound, so without the kind
comparison a container on its own bridge would pass a peer declaration.

### Check Keys

| Key | Present when | Statuses |
|---|---|---|
| `compose` | the declaration is missing or unreadable | `error` (no file), `warn` + `checked: false` (unreadable) |
| `container` | always | `ok` (running), `error` (not found, or stopped with the reason), `warn` + `checked: false` (could not check) |
| `health` | the container has a docker healthcheck | `ok` (healthy), `warn` (starting), `error` (anything else) |
| `restart` | compose readable | `ok`, `error` (policy differs) |
| `image` | compose readable | `ok`, `warn` (differs, or none declared) |
| `network` | compose readable | `ok`; `error` (kind differs, peer stopped, peer gone, or not attached to the named network); `warn` (bound to a stale id while the peer runs) |
| `door` | compose declares `<name>-door` | `ok`, `error` (not found or stopped), `warn` + `checked: false` (could not check) |
| `volumes` | no volumes declared | `ok` |
| `volume:<target>` | one per declared volume | `ok`; `warn` (host path missing, or source differs); `error` (not mounted, or a `/workspace` bind source) |
| `docker-socket` | compose mounts the docker socket | `ok`, `error` (not mounted) |
| `ports` | compose readable | `ok`, `error` (a published port is not bound), `warn` (door missing, ports not verifiable) |
| `env` | compose readable | `ok`, `warn` (a declared key is absent); keys matching `password`, `token`, `key` or `secret` are not compared |

The report's own `status` is `error` when any row is, else `warn` when any row is, else `ok`.

## Subnet Pool

Each PAD with a service on its project `default` network gets a fixed /24 out of
`10.200.0.0/16`, declared in its compose file and stored as `SUBNET` in `meta.env`
(`vm-manager/subnets.js`). The pool is disjoint from the docker daemon's default address
pools, so creating a PAD never depends on those having room. When to reserve, keep, re-pick or
release is in [Backend Services](services.md#vm-manager-servicesvm-manager).

`pickFreePadSubnet` hands out the lowest third octet that nothing claims. A /24 is claimed
when either source has it:

| Source | Function | Counts |
|---|---|---|
| Live docker networks | `usedPadSubnetOctets` | every subnet of every network on the host |
| Reservations | `reservedPadSubnetOctets` | the `SUBNET` of every other instance directory; hidden directories are skipped |

- **Both sources count.** A reservation is not a network: a PAD that has never been started on
  its default network holds its /24 on paper only. Counting live networks alone hands the same
  /24 out twice, and the second PAD finds out when compose answers `Pool overlaps`.
- **A network counts for every /24 it overlaps.** `padPoolOctetsCovered` does not require a
  /24: `10.200.0.0/20` claims octets 0 to 15 and `10.0.0.0/8` claims the whole pool. This
  covers networks that belong to other projects.
- **A failed listing is an error.** When `docker network ls` fails, the picker throws
  `Could not list docker networks to pick a free PAD subnet: <docker's first line>`. "Could
  not list" is not "nothing is used". One network that disappears between the listing and its
  inspect is skipped; that is a race, not a failed probe.
- **A full pool is an error.** `ensurePadSubnet` throws when all 256 /24s are claimed.

## Deleting a PAD

`POST /api/agents/:name/delete` and the MCP `delete_agent` tool both call `removeVm(name)` and
then `registry.removeAgentFromDb(name)`.

| Removed | By | Note |
|---|---|---|
| The container | `docker rm -f <name>` | |
| The forwarding door | `docker rm -f <name>-door` and `<name>-web` | it would keep holding the host ports |
| The network | `docker network rm <name>_default` | |
| The workspace source | `workspaceSourceRemoval` | only under the rule below |
| The instance directory | `removeInstanceDir` | includes `meta.env`, so the /24 reservation goes with it |
| The per-PAD image | `docker rmi`, then `docker image prune -f` | dangling layers only |
| The runner MCP token | `runner-mcp-token.revoke(name)` | |
| Database rows | `activity_events`, `sessions`, `agents` | |

The REST route also captures the container's logs before the delete and clears the PAD's
create and `update:<name>` job logs.

The runner token is revoked because a copy of it in an old config, a workspace or a backup
would keep authenticating, and would be bound to whatever PAD is later created under the same
name.

### Workspace Source Rule

A workspace source inside the PAD's own data directory goes with the instance directory. A
source outside the project root is never touched. For a source elsewhere under the project
root, `workspaceSourceRemoval` allows the delete only when all of these hold:

- The create made the folder: `meta.env` carries `WORKSPACE_CREATED=1`, which `createVm`
  writes only when the folder did not exist and it created it. A PAD without the flag keeps
  its source.
- No other PAD has the same `WORKSPACE_HOST` (`padsOnSameWorkspace`).
- The folder is strictly inside the project root, not the root itself.
- The folder does not contain `instances/`.

When the source is kept, the webui log says why:
`[delete <name>] workspace source <path> kept: <reason>`. The rule is a pure function so that
it is tested without touching a disk; a PAD that mounted the repository, `docs/` or a folder a
second PAD still uses must not take it along.

Both the web UI's delete and the MCP `delete_agent` tool run these steps in this order and hold
the PAD's change lock while they do, so a delete is refused with `pad_change_in_progress` while a
change is still being applied.

## See Also

- [Backend Services](services.md) — the functions behind each rule
- [Operations](../operations/overview.md) — create, settings and delete from the operator's side
- [Health tab](../tabs/health.md) — how the health report is shown
- [Testing](../operations/testing.md) — the test seams these modules expose
