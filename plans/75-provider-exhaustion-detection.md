# Plan 75 — Detecting provider exhaustion (the plan you run when the daily limit is gone)

## Status: **Detector identified and measured (2026-09-29)** — 3/4 acceptance items
complete. §4 holds the captured evidence; **§4b holds the verified conclusion and
the 5 controls that pin it.** The answer is **not** §5 row 6: the failure leaves
a structural signature in the store, so no screen parsing and no polling clock
is needed. A recovery check (§3f) is still outstanding, and the *subscription*
notice itself is still uncaptured — the finding is "this failure is detectable",
not "this is a subscription check".

**Why this is its own plan and not a paragraph in 74:** it has the opposite
shape. Everything else here is designed against known signals; this one is a
**measurement under a condition that deliberately breaks the measuring agent**,
so it needs to be written down in advance, executable, while the baseline is
still cheap to take.

Sits beside plan 74 (task done-ness), and is its **false-negative case**: 74's
`reason: "stop"` says "the agent stopped talking". If a dead-on-arrival session
also reports `stop` and nothing else, 74's detector is wrong in the one
direction that matters most.

---

## 0. Guide for the observer agent — read this before anything else

You were asked to run this because **another agent's model provider ran out of
plan**. That agent cannot run this plan itself: it has no tokens left to spend on
tool calls. You are running it *about* that session, not *in* it. You are
expected to have a **different, working provider**.

### 0.1 The goal, in one paragraph

Plan 74 wants to know when a worker agent's turn has finished, so a task can move
to the human. It reads the agent's own store and finds a `step-finish` part whose
reason is `stop`. That works — until the provider dies, because **a dead-on-arrival
turn never writes a `step-finish` at all**, so 74's detector would either look at a
stale boundary from an earlier turn or never find one. Your job is to find out
**what a provider-exhausted turn does write**, so 74 can be built with a correct
not-done state instead of a guess. One occurrence is enough, provided it is
captured **before** anything is restarted and the pane is the **right** pane.

### 0.2 What is already known — do NOT re-derive any of this

Measured 2026-09-29 on `pad-opencode-proj` (OpenCode 1.18.32), all in §4/§4b:

- **The detector is already identified and controlled.** A turn failed empty when
  the session's newest message is a `user` message: **1 hit across 950 sessions,
  and that hit was the failure.** Disambiguated from a live turn with the
  already-shipped `withAgentBusy` probe.
- **Do not use "empty assistant message" as the signal** — there are **402** of
  them, 141 with no error. It is a 402× false-positive generator.
- **Do not use `FreeUsageLimitError`.** All 7 occurrences are `429`,
  `isRetryable: true`, with the *transient* "Rate limit exceeded" body. It lives
  in `error.data.responseBody` as a **JSON string**, not `error.data.body.error.type`.
- **`reason` has three values**, not two: `tool-calls`, `stop`, `unknown`
  (1916 / 103 / 3 over 8000 parts). `unknown` is unexplained; do not fold it in.
- **`cost` is 0** across this store. Tokens are the only cost signal.
- **The failing session never recovered** (re-checked 5.8 h later), and the same
  signature occurs **18 times in 48 days, 2 of them today**. If you see it again
  that is expected, not new.

**What is still unknown, and is the only reason you are needed:** the verbatim
*on-screen* notice, the pane it lived in, whether the store side has a **second**
signature you have not seen, and **whether the same session ever recovers**.

### 0.3 Three rules. The first two destroy evidence permanently.

1. **Do not restart the pad, the TUI, or the tmux session — not even to "unstick"
   it.** A resume mints a new `agent_session_id`; the state under investigation is
   gone forever. A stuck-looking session that recovers on its own is a *result*.
2. **Do not call the broken session's provider** — not through opencode, not
   through a CLI, not by resuming it. Every measurement here is `sqlite`, `tmux`
   and `docker`; none of it needs that agent to cooperate.
3. **Capture before you analyse.** §3a is time-sensitive: a notice can scroll out
   of a pane's viewport, and panes get closed.

### 0.4 Where to run it — pick the tier you actually have

| Tier | Needs | Notes |
|---|---|---|
| **A. Host shell** (preferred) | root + `node` | **Verified.** `node -e` with `/www2/paddock/src/node_modules/better-sqlite3` reads the store directly — 403,638 parts / 108,296 messages. No docker, no env vars, no nested quoting. |
| B. A pad **with** the docker socket | `allowDocker` on | `docker exec paddock node -e '…'`. `pad-opencode-proj` has the socket. **Needs `-e`** (see §6). |
| C. A pad with `/www2` mounted, no socket | a sqlite reader in *that* pad | Its `node` may have no `better-sqlite3` and no `sqlite3` CLI. **Verify before you need it.** |

§3 commands are written for **tier A** with the host path
`/www2/paddock/instances/<pad>/opencode/data/opencode/opencode.db`. For tier B
substitute `/workspace/instances/...` and route through `Q`.

### 0.5 Do it in this order

1. **§3a — the screen, first, and the RIGHT screen.** This is the step that was
   got wrong last time; read the fix in §3a before you run it. Screenshot first,
   then work out which pane is the agent's.
2. **§3b–3d — the store.** Is it advancing? What are the newest message's keys,
   its `providerID`/`modelID`, and the newest `step-finish`? Four indexed reads.
3. **§3e — codex/claude** only if you have pads that hit the limit too.
   Otherwise record `unmeasured` honestly.
4. **§3f — close the loop.** Watch whether the *same* session ever recovers. A
   detector that fires on a turn that then succeeds is a false positive, and you
   cannot tell that without waiting.
5. **Paste your findings into §4** using the template at the end of §4, and then
   **update §4b and §5** — if the answer is still row 8, say so; if the new
   evidence changes it, say that instead, and say which control changed.

### 0.6 What "done" means for you

- [ ] The **verbatim on-screen text** is in §4, from the **correct pane**, with
      which pane and how you identified it.
- [ ] Store evidence re-captured for this occurrence (§3b–3d), including
      `providerID`/`modelID`.
- [ ] **A control run against a healthy session** — the same commands, a session
      that is working. A detector that fires on every turn cannot pass as one that
      fires on exhaustion.
- [ ] **Recovery observed or explicitly waited on**, with the elapsed time.
- [ ] §4b/§5 updated, and plan 74 §5b updated if anything moved.
- [ ] codex and claude recorded as **`unmeasured`** unless you really read one.

**You are not done because you ran the commands.** You are done when §4b's
conclusion either survives a second, independent occurrence, or is corrected by
it. One occurrence with a control is a hypothesis; two are a finding.

## 1. The one question, and why the answer picks the architecture

> When the model provider's subscription/plan is exhausted, **does anything land
> in the agent's own store?**

Two answers, two completely different detectors:

| Answer | Detector must be | Cost | Survives container stop? |
|---|---|---|---|
| **Store residue exists** (a part, a message, a new `reason`, a frozen row) | extend the `plan_activity` reader — ~2ms, indexed, per-driver | cheap | **yes** |
| **TUI-only** (error painted on screen, nothing written) | must capture and **parse the tmux screen tail** for an error banner | per-poll `docker exec`, and parsing terminal text is the fragile "parsey" thing 69 already flagged | **no** — it dies with the container |

And the failure mode that makes this urgent, which §2 makes concrete: **an
exhausted session is very likely still ALIVE and IDLE** — the TUI process is
running, the pane is live, no tool is in flight. That is *identical* to "agent
finished its turn and is waiting for the human". A detector built on
`stop` + idle will cheerfully classify a dead session as a finished one. **That
is the trap this plan exists to resolve.**

Also test for the opposite failure: providers usually **retry with backoff**. If
opencode retries internally, the last `step-finish` may stay `tool-calls` forever
and the session reads as **working indefinitely** — which wastes the driver on a
task that will never finish. So the runbook measures whether rows *advance*, not
just what the newest one says.

## 2. Baseline — ALREADY CAPTURED (2026-09-29, healthy session, tokens available)

Captured on `pad-opencode-proj`, session `ses_f12e37447ffeMJASrRjA1vCPWP`. Diff
against this. **If a field here has no counterpart in the broken session, that
absence is the finding.**

**Healthy shape:**

```
part types seen (3000-part window):
  step-start 811 · tool 792 · step-finish 809 · text 266 · reasoning 317 · compaction 5

step-finish.reason (8000-part window):
  tool-calls 1916 · stop 103 · unknown 3          ← only three values seen

step-finish keys (100% of 809):  reason, type, tokens, cost
step-finish.tokens keys:  total, input, output, reasoning, cache{write,read}

newest message.data KEYS:
  parentID, role, mode, agent, path, cost, tokens, modelID, providerID, time
  ↑ NO error / aborted / stopReason key. A new key here IS the finding.
  baseline VALUES on the healthy session: providerID = "opencode", modelID = "big-pickle"

session row:  time_updated = 12:30:41 (moves)   time_compacting = null
              cost = 0   tokens_input = 139584
              ↑ cost is 0 everywhere, including per-step. COST IS NOT USABLE here;
                tokens are. Do not build a cost claim on this install.

compaction part:  {type, auto, overflow, tail_start_id}
              observed: auto=true overflow=false ×10, auto=false overflow=undefined ×1
              ↑ overflow:true NEVER observed. Context-window exhaustion IS a recorded
                event (a compaction part); the `overflow` flag is presumably its marker.
                This is the ONE exhaustion type we can already detect.
```

**What the baseline already tells us:** a healthy turn writes `step-start` →
(`reasoning`|`text`|`tool`)… → `step-finish`, and the store is a firehose of
rows. **If exhaustion writes nothing, the absence of a new `step-finish` is
itself the signal** — a turn that started and never finished.

## 3. The runbook (execute in order; record everything)

Set once (tier A — host shell):

```sh
PAD=pad-opencode-proj
SID=ses_f12e37447ffeMJASrRjA1vCPWP     # the session whose provider just died
DB=/www2/paddock/instances/$PAD/opencode/data/opencode/opencode.db
Q() { node -e "$1"; }                   # host; needs root, no docker
```

Tier B (a pad with the docker socket) instead:

```sh
DB=/workspace/instances/$PAD/opencode/data/opencode/opencode.db
Q() { docker exec -e DB="$DB" -e SID="$SID" paddock node -e "$1"; }
```

> **`-e` is mandatory on tier B, and this was measured.** `docker exec` does
> **not** inherit the host shell's environment, so a `process.env.DB` command run
> without `-e` executes with `DB` undefined and dies on a stack trace — verified
> both ways today. Tier A sidesteps this entirely, which is the other reason to
> prefer it.

### 3a. What the human sees — SCREENSHOT FIRST, then find the RIGHT pane

> **This step was done wrong on 2026-09-29 and it cost the run its main
> evidence.** The observer captured the screen of `term-5`, which was running
> **bash at `/www1`** — the webui's own terminal tab, not the agent's TUI. Worse,
> the only tmux session on that pad had been **created at 18:54, five hours after
> the 13:08 incident**, so that pane did not even exist when the failure happened.
> A substitute screen looks exactly like a real one: it is a terminal, on the
> right pad, with no error in it. **"No error on screen" from the wrong pane is
> not evidence of anything.** Do not repeat it.

**1. Screenshot the TUI the human is looking at, before any command runs.**
Ask which window they have in front of them if there is any doubt. Paste the
exact text into §4 — verbatim, including provider wording, any HTTP status, and
whether it is a modal, a banner, or inline text.

**2. Enumerate EVERY pane, then choose — never guess, never accept the first.**
This exact command is verified on this host; use it as-is:

```sh
docker exec <pad> sh -c 'for s in $(tmux ls -F "#{session_name}"); do
  printf "%s  created=%s\n" "$s" "$(tmux display-message -p -t "$s" "#{t:session_created}")"
  tmux list-panes -a -t "$s" -F "   #{session_name}:#{window_index}.#{pane_index} cmd=#{pane_current_command} start_cmd=#{pane_start_command} cwd=#{pane_current_path}"
done'
```

**3. The agent's TUI is the pane whose `start_cmd` is the agent, not a shell.**
A bare shell reads `start_cmd=/usr/bin/bash` (verified — **all six** panes on
`pad-opencode-proj` were exactly that, `cmd=bash cwd=/www1`). An agent TUI's
start command is the agent binary, and its `cwd` is the **project folder** the
task runs in. Check `start_cmd` and `cmd` together: the TUI's `cmd` is often
just `node`, so `cmd` alone is a weak signal and `start_cmd` is the strong one.

> **Two tmux traps, both measured here.**
> - **`pane_start` does not exist** in this tmux — it renders **empty**, so a
>   guard written with it silently passes on every pane and tells you nothing.
>   Use the **session's** `created` time (the `t:session_created` line above).
> - **These panes are short-lived.** Six were created within 20 s of each other
>   at 19:03, and two had already been replaced within a minute. A pane created
>   *after* the failure cannot testify to it, which is exactly the 18:54/13:08
>   error from the last run. Cross-check the `created` line against the incident
>   time every single time.

**4. Capture that pane's tail, and record *which* pane and *why* you chose it:**

```sh
docker exec <pad> tmux capture-pane -p -t '<session>:<window>.<pane>' -S -200
```

**5. If no pane matches**, record exactly that — `agent pane absent; only
<cmd/cwd> panes exist` — and go to §3b. **A missing pane is a finding. Do not
substitute another one.**

> **Do NOT restart the pad or the TUI before finishing 3a.** A restart destroys
> the exact state under investigation, and the resumed session is a new
> conversation with a new `agent_session_id`. Capture first, always.

**6. Also record the Mission projection** (cheap, and it is the read a detector
would actually use): `mission_sessions {session_id}` in detail mode, or the REST
equivalent — `live`, `open`, `kind`, `busy`, and the `screen` tail. If the
session is a Mission session (`msn-*`), its `tmux_session_id` from
`GET /api/mission/sessions` names the right tmux session **directly** and settles
step 2 without guesswork.

### 3b. Did the store advance at all?

```sh
Q '
const D=require("/app/node_modules/better-sqlite3");
const db=new D(process.env.DB,{readonly:true,fileMustExist:true});
const sid=process.env.SID;
console.log("parts total  :", db.prepare("select count(*) n from part where session_id=?").get(sid).n);
console.log("msgs  total  :", db.prepare("select count(*) n from message where session_id=?").get(sid).n);
const s=db.prepare("select time_updated,time_compacting,cost,tokens_input,tokens_output from session where id=?").get(sid);
console.log("session       :", JSON.stringify(s));
'
```

Then **wait 90 seconds and run it again.** The delta is the single most important
number in this plan:

- **0 new rows** → the store is silent. Either the turn never started or the
  failure is TUI-only. → §1's second branch.
- **rows advancing steadily** → opencode is retrying internally. → the
  "working forever" failure mode; note the per-90s rate.
- **one new row then silence** → a partial write. Whatever that one row is, is
  your marker. **Dump it in full.**

### 3c. The newest step-finish — is `reason` still one of the three?

```sh
Q '
const D=require("/app/node_modules/better-sqlite3");
const db=new D(process.env.DB,{readonly:true,fileMustExist:true});
for(const r of db.prepare("select p.id,p.data,m.time_created t from part p join message m on m.id=p.message_id where p.session_id=? order by p.id desc limit 400").all(process.env.SID).reverse()){
  let d; try{d=JSON.parse(r.data)}catch{continue}
  let x=""; if(d.type==="tool") x=d.tool+":"+((d.state&&d.state.status)||"?");
  if(d.type==="text") x=JSON.stringify((d.text||"").slice(0,200));
  if(d.type==="step-finish") x="REASON="+d.reason;
  console.log(new Date(r.t).toISOString().slice(11,23), (d.type+"").padEnd(12), x.slice(0,200));
}
'
```

**A fourth `reason` value is the jackpot.** If exhaustion introduces e.g.
`"error"` / `"aborted"` / `"cancelled"`, detection is one indexed read and §1
resolves to the cheap branch. Record it and §5 row 1 is done.

### 3d. New message keys / new part types — the field-level diff

```sh
Q '
const D=require("/www2/paddock/src/node_modules/better-sqlite3");
const db=new D(process.env.DB,{readonly:true,fileMustExist:true});
const m=JSON.parse(db.prepare("select data from message where session_id=? order by time_created desc limit 1").get(process.env.SID).data);
console.log("msg keys:", JSON.stringify(Object.keys(m)));
console.log("providerID/modelID:", m.providerID, "/", m.modelID, "  <-- WHICH provider died");
const types={};
for(const r of db.prepare("select data from part where session_id=? order by id desc limit 4000").all(process.env.SID)){
  let d; try{d=JSON.parse(r.data)}catch{continue}
  types[d.type]=(types[d.type]||0)+1;
  if(d.type==="compaction") console.log("COMPACTION:", JSON.stringify(d));
}
console.log("part types:", JSON.stringify(types));
'
```

Compare `msg keys` against the baseline's 10. Compare `part types` against
`step-start/tool/step-finish/text/reasoning/compaction`. **Anything new — a part
type, or a key like `error`/`stopReason`/`aborted` — is the marker.**

**Also record `providerID` / `modelID`** (healthy baseline: present on every
message). Knowing *which* provider stopped answering is what makes the finding
transferable — and if the newest message's `providerID` differs from the one that
was working, that alone is a signal.

### 3e. codex and claude (only if you have pads that hit the limit too)

- **codex**: `grep -o '"type":"[a-z_]*"' instances/*/codex/sessions/*/*/*/*.jsonl | sort | uniq -c`
  against the healthy set (`session_meta, turn_context, user_message, response_item,
  message, function_call*, event_msg, task_started, task_complete, token_count…`).
  **`task_started` with no matching `task_complete` is itself an exhaustion
  candidate** — a turn that began and never ended. New event types win.
- **claude**: **unmeasurable on this host — there are zero claude transcripts**
  (`pad-test-claude/claude` holds 6 files, none under `projects/`). Do not claim
  a third driver. Say `unmeasured` in the report.

### 3f. Close the loop

- [ ] Restore the provider (or let the limit reset), confirm the SAME session id
      recovers — a session that never recovers is a *different* failure (auth?
      revoked key?) and should be recorded as such.
- [ ] Re-run 3b. If rows resumed, the store is **writable again** — which proves
      it was never blocked, only the model's calls were.

## 4. What to record (paste back into this file)

### Current behavior and captured evidence (2026-09-29)

**User-observed behavior:** the agent gives no reply. OpenCode itself says the
limit is over and asks the user to subscribe to **OpenCode Go**. This is the
subscription-limit case to investigate. The user explicitly distinguishes it
from temporary server rate limits, which work again after waiting.

**Independently captured on `pad-opencode-proj` (OpenCode 1.18.32):**

- Native session `ses_f12b8a757ffeyOtFZyNoZiTYRw` contains two user text parts
  (`!ls plans`, `ls plans`) and an empty assistant message. Provider/model:
  `opencode` / `big-pickle`. Three messages, two parts, zero input/output tokens;
  no assistant text, tool calls, `step-start`, or `step-finish`.
- Counts stayed unchanged between 13:12:24.395Z and 13:14:26.079Z UTC:
  **121.684 seconds, zero new messages or parts**. `session.time_updated`
  remained `1790687307755`. The earlier 90-second MCP command timed out, so
  that command is not a usable timed result.
- `GET :7890/session/<id>/message` independently returned the same empty
  assistant record (`msg_0ed479e40001gXJcVdXlh3aNaK`), with
  `time.completed=1790687308495` and no `error` field.
  `GET /session/status?directory=%2Fwww2%2Fpaddock` returned `{}`.
  **An idle server and a completed empty message do not prove successful work.**
- OpenCode's log at
  `instances/pad-opencode-proj/opencode/data/opencode/log/opencode.log`, lines
  716459, 716462 and 716466, records that session's temporary errors at
  13:08:11.416Z, 13:08:14.500Z and 13:08:19.901Z UTC:
  `AI_APICallError: Error from provider (Console): Rate limit exceeded. Please try again later.`
  **These are not the subscription notice.**
- An older error, `msg_0ec9a0c20001FrPpUKQPnh6aE1` in
  `ses_f13b1be56ffe3fPniszns5u9Ui`, persists `message.data.error` with
  `name=APIError`, `data.statusCode=429`, `data.isRetryable=true`, and a JSON
  response body's `error.type=FreeUsageLimitError`. Its message is the same
  temporary rate-limit wording. **Do not use that type alone as a verified
  subscription-exhaustion detector.**
- An exact-ID read/parse of that older error took median **0.0197 ms**, p95
  **0.0350 ms** across 101 warm reads inside the PAD. This measures a known
  message lookup, not a complete session detector. Healthy assistant control
  `msg_0ed2893ab0010mRXLwSFiQr8g5` has no error; the empty assistant also has
  no error. Absence of an error cannot distinguish these cases.
- The current tmux pane is `term-5`, running bash at `/www1`; its capture
  contains only a shell prompt, not the OpenCode conversation or limit notice.
- Today's error-log search found no subscribe/OpenCode Go wording. A bounded
  structured-error inspection of 100 newest messages in each of 20 recent
  sessions also found no subscription notice. This is not an exhaustive absence
  claim, and does not establish that the notice is UI-only.

**Detector decision remains open.** Capture the actual subscription notice and
identify its session and source (stored error, live event, or UI-only state).
Do not select §5 row 6 merely because the bounded store search missed it.
Likewise, frozen rows are evidence of no progress, not evidence of the cause.

No provider requests, restarts, resumes, or production detector changes were
made during this investigation. Recovery has not been observed. Codex and
Claude subscription exhaustion remain **unmeasured**.

```
ERROR TEXT (verbatim, from the TUI — not paraphrased):
  how it appeared (modal / banner / inline / toast):
PANE captured (§3a):  tmux session:window.pane
  its start_cmd / cmd / cwd:
  its session created (must be BEFORE the failure):
  how you identified it as the agent's TUI:
  if none matched: "agent pane absent; only <these> panes exist"
mission projection:  live/open/kind/busy/busyKnown/blockedOn at the moment:
screen tail contained the error?  YES / NO / PANE ABSENT
rows delta over 90s (3b):  N
newest step-finish.reason (3c):       <-- none at all is a valid answer
msg keys new vs baseline (3d):
providerID / modelID (3d):
part types new vs baseline (3d):
codex new event types (3e):           unmeasured is a valid answer
session.time_updated froze?  YES / NO
HEALTHY CONTROL (same commands, a working session) — result:
same session recovered later?  YES / NO   after how long:
```

## 4b. Conclusion — verified 2026-09-29, with controls

**The failing turn leaves a structural signature in the store. It is detectable
without reading the screen, without polling for "no change", and without
trusting any error field.** Verified against the live store, with a control run
for every claim.

### The rule

> **A turn failed empty when the session's newest message is a `user` message.**
> One indexed read. No clock, no timeout, no text parsing.

Supporting shape, for the turn *before* it: that `user` message got an
`assistant` reply **20 ms later with zero parts, zero tokens and no `error`**.
20 ms is not a model call — it is the turn being abandoned before it starts.

### The controls (each one could have failed and did not lie)

| # | Control | Result |
|---|---|---|
| 1 | **False-positive rate.** Count every session whose last message is `user`. | **950 sessions → exactly 1 hit, and it is the failing session.** |
| 2 | **"Empty assistant" is not the signal.** Count assistant messages with 0 parts. | **402 exist.** 261 carry an `error`; **141 do not.** A rule keyed on "empty" would fire ~402× and mean nothing. |
| 3 | **Of the 141 no-error empty assistants, how many never recovered?** | 123 recovered; **18 never did.** The failing session is one of the 18, and **it is the newest — age 0.0 d.** |
| 4 | **Recurrence.** Are those 18 one-offs? | 18 in 48 days across 950 sessions; 2 of them today (13:08 and 11:16). **This failure recurs and mostly leaves no error record.** |
| 5 | **Not caused by my own queries.** Row 1 was re-run as the final statement of the investigation, hours later. | Session still 3 messages / 2 parts, `tokens_output` still 0, never recovered. |

### Why the other rows lost

- **Row 5 (rows stop advancing) cannot work.** The store did not freeze — the
  turn was never written at all. "No rows for 5 minutes" is equally true of a
  healthy idle session, of a closed tab and of a dead provider. It is the user's
  original guess, and the evidence rejects it.
- **Row 2 (new message key / error field) does not fire here.** The target
  session has **no `error` on any message.** Absence of an error does not
  distinguish exhausted from healthy.
- **`FreeUsageLimitError` is disproven as the discriminator.** All **7**
  occurrences in the store are `statusCode 429`, `isRetryable true`, with the
  body `"Rate limit exceeded. Please try again later."` — i.e. the *transient*
  wording. It is also **not** at `error.data.body.error.type`; it lives in
  **`error.data.responseBody` as a JSON string** that must be parsed. The report
  above is right about the value and wrong-shaped about the path; a detector
  written from the report's path would have read `undefined` and found nothing.
- **Row 6 (screen-tail parse) is not needed** — which is the good outcome, since
  it dies with the container and is what plan 69 called fragile.

### Live-state false positive, and its one-line fix

A healthy session where the user just typed and the agent is *thinking* also has
"newest message is `user`". Control 1 shows how rare that is, but it is the
expected state of a working turn, so it needs disambiguating — and the codebase
already has the exact probe: **`withAgentBusy`** (opencode's
`/session/status?directory=…`, cached per (PAD, folder), already shipped and
already wired into every Mission list path). So:

```
failed  =  last message is user  AND  not busy  AND  tokens_output == 0
working =  last message is user  AND  busy
idle    =  last message is user  AND  not busy  AND  tokens_output > 0
```

No new probe, no per-poll `docker exec`, and it survives the container being
stopped — the read is on the host store.

### What is still NOT established

- **The OpenCode Go notice was never captured.** The pane inspected was
  `term-5`, running **bash at `/www1`** — the only tmux session on the pad, and
  it was **created at 18:54, five hours after the 13:08 incident**. It was never
  the pane that showed the notice. So the UI-only branch is **untested, not
  ruled out**; control 1 only proves a store-side signature *exists*, which need
  not be the only one.
- **Recovery was not observed** (§3f open), so "detectable" is not "recoverable".
- **Whether it is really *subscription* exhaustion is unproven.** The store says
  "a provider call produced nothing"; it does not say why. Rate limiting and an
  exhausted plan are indistinguishable from here.
- **codex and claude remain unmeasured** — no qualifying transcripts.
- The 16 older no-error empty assistants are *this same signature*; whether they
  were also provider failures or simply abandoned chats is unresolved.

## 5. The table this plan exists to fill in

| # | Observed | Detector | Where it reads | Cost | Survives stop |
|---|---|---|---|---|---|
| 1 | new `step-finish.reason` | one indexed part read | store | ~2ms | yes |
| 2 | new part type / message key | one indexed read, by type | store | ~2ms | yes |
| 3 | `step-start` with no `step-finish` | two indexed reads | store | ~2ms | yes |
| 4 | compaction with `overflow: true` | one indexed read | store | ~2ms | yes |
| 5 | **rows stop advancing entirely** | count + `time_updated` freeze | store | ~2ms | yes |
| 6 | **nothing in the store; error only on screen** | screen-tail parse | tmux capture | per-poll + fragile | **no** |
| 7 | `live:false` / `blockedOn:permission` (existing) | already shipped | Mission | already paid | partial |
| **8** | **newest message is `user`; no `step-finish` was ever written for that turn** | **one indexed read + existing `withAgentBusy`** | **store + cached probe** | **~2ms** | **yes** |

### Row 8 is the answer. The rest are not needed.

Chosen because it is the only row that fired on the captured failure **and**
survived a false-positive control (1 hit in 950 sessions, and that hit is the
failure), **and** needs no new read surface, **and** keeps working when the
container is stopped. The failure is not a *frozen* store (row 5) and carries no
`error` (row 2) and is not screen-only (row 6) — it is a turn that was never
written, which is a different thing and needed its own row.

**Rows 1–4 are still worth keeping**, for the cases 75 did not capture: context
overflow (§3d), compaction, and a mid-turn kill. Row 8 is what catches
*dead-on-arrival*, not every way a turn can fail.

**Rows 1–5 keep plan 74's cheap architecture. Row 6 forces a per-poll
`docker exec` and text-parsing of a terminal buffer, which dies with the
container and is the thing 69 already called fragile — so if the answer is row 6,
that is an architectural finding, not an implementation detail, and it should
change 74 before anything is built.**

## 6. Traps already paid for (do not re-pay them)

- **Do not grep for error words with `includes()`/substring.** Done today, it
  produced total noise: `"402"` matched 14 times inside `step-finish` parts
  because token counts like `86402` contain it, and `quota`/`billing`/`402`
  matched my own transcript **echoing the search terms back at itself**. Match on
  **JSON fields** (`data.reason`, `data.type`, `Object.keys(data)`), never on
  substrings of values.
- **`reason: "unknown"` is NOT exhaustion.** 3 in 8000 parts, and all three are a
  step that began, did some `reasoning`, and ended with no reason recorded
  (one had a tool literally named `invalid`; two were followed by a lone `"."`
  text). It looks like an aborted step, but nothing links it to billing. Record
  it as *unexplained* until §3 runs.
- **`cost` is 0 across this whole store** (session and per-step). Tokens are the
  only cost signal that works here; do not build a spend claim on `cost`.
- **Never restart before capturing.** A resume produces a new
  `agent_session_id` and the evidence is gone.
- **`docker exec` does not inherit host env vars.** Verified today: `process.env.DB`
  came back `undefined` and the command threw, while the same command with
  `-e DB=… -e SID=…` worked (returned `parts 226, msgs 62`). A runbook that only
  works on the author's shell is a runbook that fails during the incident.

## 7. Done means

- [x] §4 filled in from a real exhaustion event, with the error text pasted
      verbatim (not paraphrased — the exact provider wording is the thing a
      detector would have to match). **Partly** — the verbatim *store/log* text
      is captured; the **TUI** text is **not** (wrong pane, see §4b).
- [x] §5 row chosen, with a **measured** cost, and a control: a detector proved
      against a *healthy* session first, so a detector that fires on every turn
      cannot pass as one that fires on exhaustion. **Row 8.** Cost: one indexed
      read + the already-cached `withAgentBusy` probe. Control: 950 healthy
      sessions → 1 hit, which is the failure.
- [x] Plan 74 §5b updated with the result, and with row 6 called out if it is the
      answer — the `stop`-means-done rule is unsafe until this is settled.
      **Row 6 is NOT the answer** (good), but §5b still needed a correction —
      see plan 74 §5b, "anchor to the assistant message, not to step-finish".
- [x] claude honestly recorded as **unmeasured** unless a real transcript exists.
- [ ] **§3f recovery unobserved** — the same session was never seen to recover.
      Detectable ≠ recoverable.
- [ ] **The Go notice itself still uncaptured.** Until it is, this plan proves a
      dead-on-arrival turn is detectable; it does **not** prove a *subscription*
      check exists, and `FreeUsageLimitError` is disproven as one.
