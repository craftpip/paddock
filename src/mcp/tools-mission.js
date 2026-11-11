/**
 * Mission tools: projects, sessions, send, permission answers and session lifecycle.
 * Thin adapters over services/mission.
 */
const { z } = require('zod');
const mission = require('../services/mission');
const { McpError, ErrorCode } = require('@modelcontextprotocol/sdk/types.js');
const plans = require('../services/plans');

/** Register this area's tools. `registerToolBound` is mcp.js's error-catching wrapper;
 *  `ctx` carries the helpers mcp.js owns. */
module.exports = function register(registerToolBound, ctx) {
  const {
    currentUser, requireTool, missionCallSync, missionVisibleAgents, missionWithLive,
    missionSelectProjects, missionProjectRow, textResult, missionRequireSession, missionCall,
    missionSessionRow, missionRequireProject, missionMaySee, missionActor,
  } = ctx;

 // end PADDOCK_TASK_QUEUE gate — service below stays loaded

  // ─── Mission (plan 55) ───────────────────────────────────────────────────
  // A project is (PAD, folder); a session is the only unit of work — a live TUI
  // in that folder that the human and the agent both type into and both watch.
  // Only the three coding drivers have Mission projects (opencode, codex,
  // claude), enforced in the service so this surface cannot walk around it.

  registerToolBound(
    'mission_projects',
    {
      title: 'List Mission projects',
      description: "The Mission page's projects: each is a (PAD, folder) pair, with its sessions and how many are live. Only the coding agents (opencode, codex, claude) have projects — a personal agent (openclaw, picoclaw, hermes) cannot. Scoped to what your key may see, so a project on someone else's PAD is simply absent. **These counts are LIVENESS, not progress**: `sessionCount` is how many sessions the project ever had, `liveCount` how many hold a pane, `openCount` how many hold a live TUI. A session that did 400 tool calls and one that opened and died look identical here — for what a project is actually WORKING ON, see the plans facility (plan_list / plan_activity). Filter with `agent` (one PAD), `project_id`, `name` or `folder`; a name or folder that matches zero or several is reported with the candidates rather than returning the whole list, and a project also carries `agentStatus` so you can see whether its pad is running without a second tool. Each session also carries `busy` / `busyKnown` / `open` / `kind`, so you can tell \"the human is typing right now\" from \"here but idle\" from \"a dead pane\" from \"a live shell\" without opening the session — but read `mission_sessions` for the rows themselves: they are opt-in here via `include_sessions`.",
      inputSchema: {
        agent: z.string().optional().describe('Only this PAD\'s projects'),
        project_id: z.string().optional().describe('Exactly this project (from a previous call)'),
        name: z.string().optional().describe('One project by its Mission name (e.g. "paddock") — refused with the candidates if it matches zero or several'),
        folder: z.string().optional().describe('One project by its folder inside the PAD (e.g. "/www2/paddock") — a project\'s name is NOT its folder, so this is usually what a caller holding a directory has'),
        include_sessions: z.boolean().optional().describe('Also inline each session (default false — use mission_sessions)'),
      },
    },
    async ({ agent, project_id, name, folder, include_sessions }) => {
      const user = currentUser();
      if (agent) requireTool(user, 'mission_projects', agent);
      const projects = missionCallSync(() =>
        mission.listProjects({ agent: agent || '', agents: missionVisibleAgents(user) })
      );
      // Never fail the list on liveness: fall back to un-stamped rows. The busy
      // pass is the page's own second step (`withAgentBusyProjects`) — it is what
      // turns "live" into "the human is mid-turn", and it is cached per
      // (PAD, folder), so it costs one probe per project, not per row.
      const live = (await missionWithLive(() => mission.withLive(projects))) || projects;
      const marked = (await missionWithLive(() => mission.withAgentBusyProjects(live))) || live;
      const selected = missionSelectProjects(marked, { projectId: project_id || '', name: name || '', folder: folder || '' });
      const rows = selected.map((p) => missionProjectRow(p, { includeSessions: !!include_sessions }));
      return textResult({
        projects: rows,
        total: rows.length,
        ...(name || folder || project_id ? { matched: rows.length } : {}),
        ...(include_sessions ? {} : { hint: 'Sessions omitted — pass include_sessions: true, or read mission_sessions {project_id}.' }),
        supportedAgentTypes: mission.supportedTypes(),
      });
    }
  );

  registerToolBound(
    'mission_sessions',
    {
      title: 'List Mission sessions — or read one session\'s screen',
      description: "A session IS the unit of work on the Mission page: a live agent TUI in a project's folder, typed into by the human and by you. List mode (no `session_id`) returns every session your key can see, with its project, agent, folder and live/dead state — filter with `project_id` / `agent`. Detail mode (`session_id`) returns that session's metadata, its pane state, and the tail of what its TUI is showing RIGHT NOW, so you can see what the human is doing without them narrating it. Read `mission_sessions` before typing into a session you did not start; a session with `locked: true` is the human's deliberate \"driving alone\" switch.\n\n**LIVENESS, and the three fields are not interchangeable.** `live` = we hold a tmux pane. `busy` = a turn is streaming RIGHT NOW, and it requires `live` (a dead row is never busy; if a dead row carries `wasBusy: true` the conversation is still working somewhere you cannot reach). `open` = a LIVE TUI is attached to the conversation — never a dead row, never a bare shell. It is NOT the send verdict: a solo-locked row and a permission-parked row are both still `open` (the human may be driving them). Ask `canSend` in detail mode, which is the same check the write path applies. `busyKnown: false` means the probe COULD NOT ANSWER, which is not the same as idle, so never treat it as licence to type. `state: \"dead\"` is a corpse. Each row also carries `kind`: `\"agent\"` means a TUI is in the pane, `\"shell\"` means a send would run SHELL COMMANDS (mission_send refuses it) — check this before typing.\n\n**HOW A SESSION ENDED** (`endedAt` / `endedBy`, plan 65). `endedBy: \"recreate\"` is a death we CAUSED, dated exactly, when a recreate killed the PAD's tmux sessions. `endedBy: \"gone\"` means the first time we LOOKED and it was already gone — so `endedAt` is an upper bound, never the instant of death; the only exact claim is that it was alive at the last probe before it. An absent `endedAt` means the row was never observed dead, NOT that it is running: `live` answers that.\n\nDetail mode reports `blockedOn: \"permission\"` (with the tool and path) when the pane is parked on a permission dialog: that session is blocked, NOT idle, and `mission_send` refuses it — answer it with `mission_permission_answer`. `screenFrom` says WHICH screen you are reading: `live-pane` (showing now), `last-captured` (the last thing we saw before the pane went — the only way to read a dead session's chat, and never blank for a corpse that said something), or `none` (nothing was ever captured). Always read a screen with its `lastScreenAt`.",
      inputSchema: {
        session_id: z.string().optional().describe('One session in full — metadata + pane state + screen tail'),
        project_id: z.string().optional().describe('Only this project\'s sessions'),
        agent: z.string().optional().describe('Only sessions on this PAD'),
        lines: z.number().int().min(1).max(200).optional().describe('Screen tail length in detail mode (default 40, max 200)'),
        limit: z.number().int().min(1).max(200).optional().describe('List mode: how many sessions to return, newest first (default 50, max 200)'),
      },
    },
    async ({ session_id, project_id, agent, lines, limit }) => {
      const user = currentUser();

      // Detail mode — one session, with its screen. The row is stamped by
      // `mission.screen` itself (plan 62 1d): it already probes the pane, so
      // running a second decoration pass here would either duplicate the probe
      // or — because the raw row has no `live` — stamp every session as a
      // corpse. The list/detail parity rule is satisfied by the STORE owning
      // the truth, not by both call sites remembering to decorate.
      if (session_id) {
        const { session, project } = missionRequireSession(user, 'mission_sessions', session_id);
        const r = await missionCall(() => mission.screen(session.id, lines || 40));
        return textResult({
          session: missionSessionRow(r.session, project),
          state: r.state,
          live: r.live,
          screen: r.screen,
          // WHOSE screen this is, and how old it is (plan 65 1a). `live-pane` is
          // what the TUI is showing now; `last-captured` is the last thing we
          // were shown before the pane went, which for a dead row is the only
          // way its chat can be read at all; `none` means nothing was ever
          // captured. Without this, a dead row's `screen: ""` was ambiguous —
          // an agent that had said nothing, or a capture we could not do.
          screenFrom: r.screenFrom,
          ...(r.lastScreenAt ? { lastScreenAt: r.lastScreenAt } : {}),
          ...(r.lastScreenTruncated ? { lastScreenTruncated: true } : {}),
          ...(r.blockedOn ? { blockedOn: r.blockedOn, permission: r.permission } : {}),
          // The detail view carries what a send would do, before anyone sends —
          // and it is the STORE's verdict (the same function the write path
          // gates on), never `open` re-derived here. Deriving it from `open`
          // promised `canSend: true` for a locked row and for a pane parked on
          // a permission dialog, both of which the write then refused.
          canSend: r.canSend === true,
          ...(r.canSend === true ? {} : { sendRefusal: r.refusal }),
          hint: r.live
            ? undefined
            : 'The tmux session is gone — mission_session_restart brings it back with the same conversation id; the screen above is the last one we captured.',
        });
      }

      // List mode. `agent` gets an explicit gate (a clear refusal beats a
      // silently empty list); the store filter does the per-row owner scoping.
      if (agent) requireTool(user, 'mission_sessions', agent);
      const scoped = missionVisibleAgents(user);
      const byId = new Map();
      let sessions;
      let projects;
      if (project_id) {
        const project = missionRequireProject(user, 'mission_sessions', project_id);
        byId.set(project.id, project);
        sessions = missionCallSync(() => mission.listSessions({ projectId: project.id }));
      } else {
        const all = missionCallSync(() => mission.listAllSessions({ allow: (n) => missionMaySee(user, n) }));
        for (const p of all.projects) byId.set(p.id, p);
        sessions = all.sessions.filter((s) => {
          const name = s.project?.agent_name;
          if (agent && name !== agent) return false;
          return true;
        });
        projects = all.projects.filter((p) => (!agent || p.agent_name === agent) && missionMaySee(user, p.agent_name));
      }

      const live = (await missionWithLive(() =>
        project_id
          ? mission.withLiveSessions(sessions, byId.get(project_id).agent_name)
          : mission.withLiveSessionsByAgent(sessions, (s) => s.project?.agent_name)
      )) || sessions;
      // Same second step the REST route takes: stamp busy/open so the LLM can
      // see that the human is mid-turn before it types. Read per conversation
      // from its own store (plan 52 R8); a failure here costs the stamp, not
      // the list.
      const marked = (await missionWithLive(() =>
        mission.withAgentBusy(live, (s) => byId.get(s.project_id)?.agent_name)
      )) || live;
      const capped = marked.slice(0, limit || 50);
      return textResult({
        sessions: capped.map((s) => missionSessionRow(s, byId.get(s.project_id))),
        total: marked.length,
        truncated: marked.length > capped.length,
        projects: projects || undefined,
        hint: capped.length
          ? undefined
          : 'No sessions yet — open one with mission_session_start on a project (from mission_projects).',
      });
    }
  );

  registerToolBound(
    'mission_project_create',
    {
      title: 'Create a Mission project',
      description: "Create a Mission project — a (PAD, folder) pair — on a coding agent your key owns, the LLM-side twin of the page's \"+ New project\" dialog. Row only: no container, no tmux session, no shell. A folder you pass must be an absolute path that exists INSIDE the PAD (it is probed there, and refused otherwise); omit it to use that agent type's default workspace. `plans_folder` is a relative name INSIDE the project's folder (default `plans/`) where this project's plans live — each project gets its own, so two projects on one PAD never share a plans folder. Creating a project also writes its `INDEX.md` entry file. The project appears in the Mission page's first column immediately. Not for openclaw / picoclaw / hermes — they do not support Mission.",
      inputSchema: {
        name: z.string().describe('Project name (shown in the Mission page)'),
        agent: z.string().describe('PAD name — must be an opencode, codex or claude agent you own'),
        folder: z.string().optional().describe('Absolute container path (default: that agent type\'s workspace dir)'),
        plans_folder: z.string().optional().describe("Relative folder for this project's plans, INSIDE the project folder (default `plans`). No absolute or `..` paths."),
      },
    },
    async ({ name, agent, folder, plans_folder }) => {
      const user = currentUser();
      // Gate BEFORE the probe: the probe is a container command on that PAD.
      requireTool(user, 'mission_project_create', agent);

      // Probe a PASSED folder inside the PAD before writing the row — a host path
      // that is not mounted in the container looks perfectly valid from here and
      // would only fail later, at session start. projectFolders resolves the
      // agent itself, so a mistyped PAD name is mission_agent_not_found rather
      // than a type complaint. With no folder the store picks the driver default
      // (what the page's dialog does), so there is nothing to probe.
      let dir = '';
      if (folder) {
        dir = missionCallSync(() => mission.normalizeFolder(folder));
        const probe = await missionCall(() => mission.projectFolders(agent, dir));
        if (!probe.exists || !probe.isDir) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `mission_folder_missing: ${dir} does not exist as a directory inside ${agent}` +
              (probe.entries.length ? ` — nearby: ${probe.entries.slice(0, 8).map((e) => e.name).join(', ')}` : '')
          );
        }
      }

      const project = missionCallSync(() =>
        mission.createProject({ name, agent, folder: dir, plansFolder: plans_folder, createdBy: (user && user.userId) || null })
      );
      // Initialize the project's plans folder + INDEX.md (plan 82 Phase 5), the
      // same call the REST route makes. A failure is REPORTED, not thrown: the
      // row is saved and the folder is re-created lazily on the first plan_write.
      let plansInit = null;
      try {
        plansInit = await plans.initProjectPlans(project.agent_name, project);
      } catch (e) {
        plansInit = { created: false, error: e.code || e.message || String(e) };
      }
      const row = missionProjectRow({ ...project, sessions: [], sessionCount: 0, liveCount: 0 });
      return textResult({ project: { ...row, plans_folder: project.plans_folder || 'plans' }, plansInit });
    }
  );

  registerToolBound(
    'mission_session_start',
    {
      title: 'Open a Mission session (start an agent TUI)',
      description: "Start a session in a Mission project: a fresh `msn-*` tmux session created ROOTED AT THE PROJECT FOLDER, with the agent's own TUI launched into it. This is the server path behind the page's \"+ New session\" — the TUI is launched on purpose, because a session is only useful when the human can watch it. The row is stamped `origin='agent'`, so the page badges it \"started by agent\". Refuses when the PAD is stopped (409 `mission_agent_stopped`) or the folder has vanished inside it (`mission_folder_missing`) — start the PAD or fix the project. Pass `agent_session_id` (from a session's history) to resume that conversation instead of starting a fresh one.\n\n**Pass `idempotency_key` whenever you might retry.** The row and the tmux session exist well before the TUI is up, so this call is exactly the one a client times out on — and a timed-out call returns NOTHING, so a blind retry does not find the session, it starts a SECOND conversation and burns a second agent's tokens. A repeated key returns the session you already have (`deduped: true`) instead of making another. Give every start a fresh key; reuse a key only when you are retrying that same start.",
      inputSchema: {
        project_id: z.string().describe('Project id from mission_projects'),
        label: z.string().optional().describe('Label shown on the session row (default: none)'),
        agent_session_id: z.string().optional().describe("Resume this conversation id from the agent's own history instead of starting fresh"),
        idempotency_key: z.string().optional().describe("Your own retry token for THIS start (e.g. the request id). Re-sending the same key returns the session already started (deduped) instead of opening a second one — the only safe response to a call that timed out. Use a new key per distinct start."),
      },
    },
    async ({ project_id, label, agent_session_id, idempotency_key }) => {
      const user = currentUser();
      const project = missionRequireProject(user, 'mission_session_start', project_id);
      // The key id is recorded on the row, so "did I start this?" and "was that
      // really an agent?" stay answerable after the fact instead of resting on
      // the caller's own memory (plan 67, 67.3).
      const createdBy = user && user.keyId ? `key:${user.keyId}` : null; // same spelling as missionActor()
      const r = await missionCall(() =>
        mission.startSession(project.id, {
          label: label || '',
          origin: 'agent',
          agentSessionId: agent_session_id || '',
          createdBy,
          idempotencyKey: idempotency_key || '',
        })
      );
      return textResult({
        session: missionSessionRow({ ...r.session, live: r.state ? r.state.live : null }, project),
        // `deduped` is the whole point of the key, so it is never folded into a
        // note: a caller that re-sent the key must be able to tell "you already
        // had this" from a fresh start without reading the id.
        ...(r.deduped ? { deduped: true, hint: 'This idempotency_key had already been used, so the existing session was returned — no second session was created.' } : {}),
        state: r.state,
        project: { id: project.id, name: project.name, folder: project.folder, agent: project.agent_name },
        createdBy,
        // The pane's folder is the thing that silently goes wrong (tmux starts
        // in the parent when -c is given a missing dir), so it is reported, not
        // left for the caller to discover.
        startedInFolder: r.state ? r.state.cwd : null,
        expectedFolder: project.folder,
        inExpectedFolder: !!(r.state && r.state.cwd && r.state.cwd === project.folder),
      });
    }
  );

  registerToolBound(
    'mission_send',
    {
      title: 'Type into a live Mission session',
      description: "Type a line into a session's live TUI — your way of working IN a session that already exists, side by side with the human. The session must be live AND running an agent; a solo-locked session (`locked: true`, the human's \"drive alone\" switch) is refused with `mission_session_locked`, a pane running a shell is refused with `mission_not_an_agent` (a send there would run your text as shell commands), and a pane parked on a permission dialog is refused with `mission_permission_pending` (answer it with mission_permission_answer). In every one of those cases NOTHING is typed — do not retry, use another session, relaunch, or ask. Read `mission_sessions` first when you did not start the session: you are typing into the human's conversation. Multi-line text is typed as separate lines; each line is submitted. The response echoes the project and session and returns the pane's screen, so you can see the text actually landed.",
      inputSchema: {
        session_id: z.string().describe('Session id from mission_sessions'),
        text: z.string().describe('Text to type into the TUI (submitted with Enter)'),
      },
    },
    async ({ session_id, text }) => {
      const user = currentUser();
      const { session, project } = missionRequireSession(user, 'mission_send', session_id);
      // mission.sendText is the ONE writer path (human or agent), so this is
      // also the one place the solo lock is enforced.
      const r = await missionCall(() => mission.sendText(session.id, text, { actor: missionActor(user) }));
      return textResult({
        ok: true,
        sent: r.sent,
        // Plan 88 §Phase 2: `acceptance: 'confirmed'` means the pane observed the
        // write. A resolution alone is not proof beyond what the pane showed.
        confirmed: r.confirmed,
        acceptance: r.acceptance,
        // Echo where the text went (plan 62 1i): an operator-set `label` is
        // often empty or stale, and a write that does not say which project it
        // landed in cannot be checked afterwards.
        project: r.project,
        session_id: r.session_id,
        session: missionSessionRow(r.session, project),
        // The pane's screen after the write, so "the TUI took it" is visible
        // rather than asserted (1h).
        screen: r.screen,
        // Plan 88 §Phase 3: operation status for caller reconciliation.
        operation: r.operation_id ? {
          id: r.operation_id,
          generation: r.operation_generation,
          status: r.operation_status,
          started_at: r.operation_started_at,
          confirmed_at: r.operation_confirmed_at,
        } : null,
        hint: 'The text was typed into the TUI. Read it back with mission_sessions {session_id} to see the answer.',
      });
    }
  );

  registerToolBound(
    'mission_permission_answer',
    {
      title: 'Answer a permission prompt blocking a Mission session',
      description: "A live session parked on an agent permission dialog (`△ Permission required` — a tool call waiting for a human) is BLOCKED, not idle: mission_send refuses it with `mission_permission_pending`, and the text you would send would land in the dialog and press its confirm key. This tool answers the dialog explicitly. `choice: \"once\"` selects the FIRST option (`Allow once`) and confirms; `choice: \"reject\"` selects the LAST (`Reject`) and confirms. `choice: \"always\"` is REFUSED with `mission_permission_refused` — \"Allow always\" is a durable policy change to a machine's permissions, which is the human's decision, not yours. Read the dialog's tool and path first (`mission_sessions {session_id}` reports `blockedOn: \"permission\"` with them) and prefer `reject` if you did not expect that call.",
      inputSchema: {
        session_id: z.string().describe('Session id from mission_sessions — the one showing the permission dialog'),
        choice: z.enum(['once', 'reject']).describe('\"once\" allows this single call, \"reject\" refuses it. \"always\" is not available to an agent caller.'),
      },
    },
    async ({ session_id, choice }) => {
      const user = currentUser();
      const { session, project } = missionRequireSession(user, 'mission_permission_answer', session_id);
      const r = await missionCall(() => mission.answerPermission(session.id, choice));
      return textResult({
        ok: true,
        choice: r.choice,
        project: r.project,
        session_id: r.session_id,
        session: missionSessionRow(r.session, project),
        stillPending: r.stillPending,
        screen: r.screen,
        hint: r.stillPending
          ? 'The dialog is still on screen — read it with mission_sessions {session_id} before answering again.'
          : 'The prompt is gone. Read the session to see what the agent did next.',
      });
    }
  );

  // --- the session lifecycle (plan 65 1e) --------------------------------
  // Until these existed, a dead session was a DEAD END for an agent: the tools
  // could resume a conversation (mission_session_start {agent_session_id}) and
  // read one (mission_sessions detail, plan 65 1a), but nothing could bring a
  // session BACK or end one, so the only recovery was to ask the human. The two
  // recovery paths are the Mission PAGE's own buttons — the service functions
  // `relaunchTui` / `restartSession` already existed and are the half that was
  // missing — so the MCP side refuses exactly where the page does.
  //
  // `mission_project_delete` is deliberately NOT here. Deleting a project takes
  // the ROW and (per AGENTS.md) every tmux session on that agent with it,
  // including live conversations the human is looking at; that is the one
  // verb here whose blast radius is not the session you named, so it stays a
  // human action on the page.

  registerToolBound(
    'mission_session_close',
    {
      title: 'End a Mission session (kill its pane, keep the record)',
      description: "End a session deliberately: the pane is killed and the row is stamped `endedBy: \"closed\"` — the conversation is NOT deleted and the row STAYS, so the session remains auditable and resumable. (The Close button on the Mission page is the other thing: it also forgets the row, and that is a human's call.) The pane's screen is captured before the kill, so `lastScreen` on the row is the last thing the agent said. Refuses with `mission_session_dead` when the pane is already gone — the row is already dated, so there is nothing to do. Works on a solo-locked session, deliberately: `locked` says who may TYPE, not who may end a session. A permission dialog does NOT need answering first; closing discards it.",
      inputSchema: {
        session_id: z.string().describe('Session id from mission_sessions'),
      },
    },
    async ({ session_id }) => {
      const user = currentUser();
      const { session, project } = missionRequireSession(user, 'mission_session_close', session_id);
      const r = await missionCall(() => mission.endSession(session.id, { actor: missionActor(user) }));
      return textResult({
        ok: true,
        session_id: r.session.id,
        session: missionSessionRow({ ...r.session, live: false }, project),
        project: r.project,
        // What the agent was last showing, captured BEFORE the kill. Reported
        // here as well as stored, because a close is the one death this system
        // gets to witness and the caller will not read the row again.
        screen: r.screen,
        // Resumable is ALWAYS true — the row, the tmux id and the pane come back.
        // What varies is whether the CONVERSATION does, and that turns on the
        // stored `agent_session_id`, so both facts are reported instead of
        // collapsing them into one nullable field: `null` here would have read
        // as "this session cannot be resumed", which is wrong for a row that
        // mission_session_restart reopens today.
        resumable: {
          via: 'mission_session_restart (same row, same tmux id)',
          conversation: r.session.agent_session_id ? 'same' : 'new (this row never recorded an agent session id)',
          ...(r.session.agent_session_id ? { agent_session_id: r.session.agent_session_id } : {}),
        },
        hint: 'The pane is gone and the row is dated. Reopen it with mission_session_restart.',
      });
    }
  );

  registerToolBound(
    'mission_session_relaunch',
    {
      title: 'Relaunch a session whose TUI exited (same pane, same conversation)',
      description: "The recovery for a session whose tmux pane is still there but whose agent TUI dropped back to the shell — the pane is live, so the TUI is re-launched INTO it, resuming the SAME conversation when the row remembers its `agent_session_id`. Use this when `mission_sessions` reports `live: true` with `kind: \"shell\"`. Refuses with `mission_session_dead` when the pane is gone (use `mission_session_restart` instead) and with `mission_tui_already_running` when a TUI is live — retyping the launch command would start a SECOND conversation in the same pane. The pane is `cd`-ed to the project's folder first if it drifted.",
      inputSchema: {
        session_id: z.string().describe('Session id from mission_sessions — the one with kind: "shell"'),
      },
    },
    async ({ session_id }) => {
      const user = currentUser();
      const { session, project } = missionRequireSession(user, 'mission_session_relaunch', session_id);
      const r = await missionCall(() => mission.relaunchTui(session.id, { actor: missionActor(user) }));
      return textResult({
        ok: true,
        session_id: r.session.id,
        session: missionSessionRow(r.session, project),
        project,
        state: r.state,
        hint: 'The TUI is starting. mission_sessions {session_id} shows whether it has come up yet — this call does not wait for it.',
      });
    }
  );

  registerToolBound(
    'mission_session_restart',
    {
      title: 'Restart a dead session (same row, same tmux id, same conversation)',
      description: "The recovery for a session whose tmux session is GONE: the pane is re-created with the same tmux id, rooted at the PROJECT's folder, and the agent is re-launched resuming the same `agent_session_id` — so the row, the tmux name and the conversation all survive. Use this when `mission_sessions` reports `state: \"dead\"`. Refuses with `mission_tui_already_running` when a TUI is already live, and with `mission_folder_missing` when the project's folder no longer exists inside the PAD — it is checked BEFORE anything is created, because `tmux new-session -c` does not fail on a missing directory, it silently starts the pane in the PARENT. Clears the row's `endedAt`/`endedBy`, because the session is alive again.",
      inputSchema: {
        session_id: z.string().describe('Session id from mission_sessions — the dead one'),
      },
    },
    async ({ session_id }) => {
      const user = currentUser();
      const { session, project } = missionRequireSession(user, 'mission_session_restart', session_id);
      const r = await missionCall(() => mission.restartSession(session.id, { actor: missionActor(user) }));
      return textResult({
        ok: true,
        session_id: r.session.id,
        session: missionSessionRow(r.session, project),
        project: { id: project.id, name: project.name, folder: project.folder, agent: project.agent_name },
        state: r.state,
        // The folder is the thing that silently goes wrong (a pane in the
        // parent of the folder you asked for), so it is reported rather than
        // left for the caller to discover.
        startedInFolder: r.state ? r.state.cwd : null,
        expectedFolder: project.folder,
        inExpectedFolder: !!(r.state && r.state.cwd && r.state.cwd === project.folder),
        hint: 'The TUI is starting. mission_sessions {session_id} shows whether it has come up yet.',
      });
    }
  );
};
