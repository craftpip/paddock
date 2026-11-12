/**
 * Mission projects and sessions: the REST surface the Mission page uses.
 */
const registry = require('../services/agent-registry');
const mission = require('../services/mission');
const plans = require('../services/plans');
const { getDb } = require('../services/db');
const { csrfCheck } = require('../middleware/auth');

/** Register this area's routes on the app. `ctx` carries the helpers app.js owns. */
module.exports = function register(app, ctx) {
  const {
    canTouchAgent, missionFail, missionActorFor,
  } = ctx;

  // ─── API: Mission (plan 53) ─────────────────────────────────────────────────
  // A project is an (agent, folder) pair; a session is the only unit of work —
  // one live tmux session per row running the agent's TUI in the project's folder,
  // typed into by the human and the agent alike. Phase 0: the store + validation.
  // The tmux half (launch TUI / send keys / capture) lands in Phase 1, so the CRUD
  // surface is testable on its own.

  /** PAD names the caller may touch. Admins get null (= no filter). */
  function missionAllowedAgents(req) {
    if (req.session.role === 'admin') return null;
    return getDb().prepare('SELECT name FROM agents WHERE owner_id = ?').all(req.session.userId).map((r) => r.name);
  }

  /** Load a project the caller is allowed to see, or answer 403/404 for them. */
  function missionProject(req, res) {
    let project;
    try {
      project = mission.getProject(req.params.id);
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message, code: e.code });
      return null;
    }
    if (!canTouchAgent(req, project.agent_name)) {
      res.status(403).json({ error: 'Access denied' });
      return null;
    }
    return project;
  }

  /** A session plus its project, access-checked. Returns { session, project }. */
  function missionSession(req, res) {
    let session;
    try {
      session = mission.getSession(req.params.id);
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message, code: e.code });
      return null;
    }
    let project;
    try {
      project = mission.getProject(session.project_id);
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message, code: e.code });
      return null;
    }
    if (!canTouchAgent(req, project.agent_name)) {
      res.status(403).json({ error: 'Access denied' });
      return null;
    }
    return { session, project };
  }

  app.get('/api/mission/projects', (req, res) => {
    try {
      const projects = mission.listProjects({ agent: req.query.agent || '', agents: missionAllowedAgents(req) });
      // liveness, then the agent's own "is this conversation working" view. Both
      // are decoration on the list: neither is allowed to fail it.
      mission
        .withLive(projects)
        .then((live) => mission.withAgentBusyProjects(live))
        .then((live) => mission.withFolderState(live))
        .then(
          (live) => res.json({ projects: live }),
          () => res.json({ projects }) // liveness is decoration; never fail the list on it
        );
    } catch (e) {
      missionFail(res, e);
    }
  });

  app.post('/api/mission/projects', csrfCheck, async (req, res) => {
    try {
      const project = mission.createProject({
        name: req.body.name,
        agent: req.body.agent,
        folder: req.body.folder,
        plansFolder: req.body.plansFolder,
        createdBy: req.session.userId || null,
      });
      if (!canTouchAgent(req, project.agent_name)) {
        mission.deleteProject(project.id);
        return res.status(403).json({ error: 'Access denied' });
      }
      // Initialize the project's plans folder + INDEX.md (plan 82 Phase 5). A
      // failure here must NOT lose the project: the row is already saved and the
      // folder is re-created lazily on the first plan_write. So the outcome is
      // reported alongside the project rather than thrown — a create that says
      // "done" while the workspace was unwritable is the lie to avoid.
      let plansInit = null;
      try {
        plansInit = await plans.initProjectPlans(project.agent_name, project);
      } catch (e) {
        plansInit = { created: false, error: e.code || e.message || String(e) };
      }
      res.json({ project, plansInit });
    } catch (e) {
      missionFail(res, e);
    }
  });

  app.get('/api/mission/projects/:id', (req, res) => {
    const project = missionProject(req, res);
    if (!project) return;
    try {
      mission
        .withLiveSessions(mission.listSessions({ projectId: project.id }), project.agent_name)
        // The per-session busy probe reads each row's OWN conversation in the
        // agent's store (plan 52 R8(a)) — no folder is involved, because the id
        // is the key and the process that drives it is irrelevant.
        .then((sessions) => mission.withAgentBusy(sessions, () => project.agent_name))
        .then(
          (sessions) => res.json({ project, sessions }),
          () => res.json({ project, sessions: mission.listSessions({ projectId: project.id }) })
        );
    } catch (e) {
      missionFail(res, e);
    }
  });

  app.patch('/api/mission/projects/:id', csrfCheck, (req, res) => {
    const project = missionProject(req, res);
    if (!project) return;
    try {
      res.json({ project: mission.updateProject(project.id, { name: req.body.name, folder: req.body.folder, plansFolder: req.body.plansFolder }) });
    } catch (e) {
      missionFail(res, e);
    }
  });

  app.delete('/api/mission/projects/:id', csrfCheck, (req, res) => {
    const project = missionProject(req, res);
    if (!project) return;
    try {
      // Kill the project's tmux sessions before the rows go, so deleting a
      // project can never leave an orphan TUI running in the PAD. A PAD that is
      // already gone makes killSession a no-op by design.
      //
      // The project's runners go first, through the same removal a runner's own
      // Remove uses: deleting a project IS an explicit removal of every runner
      // configuration in it, so each one's `destroy` callback is recorded (from
      // the saved script, while the project row still exists to name it) — a
      // bare cascade dropped the rows and the callback never fired.
      const actor = missionActorFor(req);
      mission.removeProjectRunners(project.id, { actor })
        .then(() => Promise.all(
        mission.listSessions({ projectId: project.id }).map((s) =>
          // No actor passed: this is the PLATFORM tearing a project's sessions
          // down as a side effect of deleting it, not a human closing each one.
          // 'system' is the honest value, and it is a real distinction — a
          // `user:` row here would put a name on a decision the user never made.
          mission.closeSession(s.id).catch(() => {})
        )
      )).then(() => {
        mission.deleteProject(project.id);
        res.json({ ok: true });
      }, (e) => missionFail(res, e));
    } catch (e) {
      missionFail(res, e);
    }
  });

  /** Every live session across every project, each tagged with its project — the
   *  backend half of the page's "All projects" scope (plan 53 Phase 6). Same
   *  shape as the per-project list plus a `project` object per row, because a
   *  session label on its own cannot say which folder it belongs to. The tmux
   *  check is grouped per AGENT (one `list-sessions` per PAD), not per project. */
  app.get('/api/mission/sessions', (req, res) => {
    const allow = (agentName) => canTouchAgent(req, agentName);
    let all;
    try {
      all = mission.listAllSessions({ allow });
    } catch (e) {
      return missionFail(res, e);
    }
    mission
      .withLiveSessionsByAgent(all.sessions, (s) => s.project?.agent_name)
      // Each row is asked about in ITS OWN conversation (the store read keys on
      // the row's agent_session_id, so a one-list-spans-folders scope needs no
      // folder) — plan 52 R8(a).
      .then((sessions) => mission.withAgentBusy(sessions, (s) => s.project?.agent_name))
      .then((sessions) => res.json({ sessions, projects: all.projects }),
        () => res.json({ sessions: all.sessions, projects: all.projects }));
  });

  /** The same "All projects" scope for the agent's own history: every project's
   *  conversations merged and date-sorted. A project that cannot be read is
   *  reported in `errors` instead of failing the whole read — one stopped PAD
   *  must not blank the column. */
  app.get('/api/mission/history', (req, res) => {
    mission
      .allAgentHistory({
        limit: parseInt(req.query.limit, 10) || 50,
        includeSubfolders: req.query.subfolders === '1',
        allow: (agentName) => canTouchAgent(req, agentName),
      })
      .then((h) => res.json(h), (e) => missionFail(res, e));
  });

  app.get('/api/mission/projects/:id/sessions', (req, res) => {
    const project = missionProject(req, res);
    if (!project) return;
    try {
      mission
        .withLiveSessions(mission.listSessions({ projectId: project.id }), project.agent_name)
        .then((sessions) => mission.withAgentBusy(sessions, () => project.agent_name))
        .then(
          (sessions) => res.json({ sessions }),
          () => res.json({ sessions: mission.listSessions({ projectId: project.id }) })
        );
    } catch (e) {
      missionFail(res, e);
    }
  });

  /** The conversations that already happened in this project's folder, read from
   *  the agent's OWN store (opencode.db / codex rollouts / claude jsonl) — not
   *  from `mission_sessions`. This is what makes a project that points at a
   *  folder you have already worked in show that work instead of an empty column.
   *  `?subfolders=1` widens it to conversations that ran in nested folders. */
  app.get('/api/mission/projects/:id/history', (req, res) => {
    const project = missionProject(req, res);
    if (!project) return;
    mission
      .agentHistory(project.id, {
        limit: parseInt(req.query.limit, 10) || 50,
        includeSubfolders: req.query.subfolders === '1',
      })
      .then((h) => res.json(h), (e) => missionFail(res, e));
  });

  /** Open a session: create the tmux session rooted at the project's folder and
   *  launch the agent's TUI into it. No headless variant by design — the work
   *  must be visible. `agentSessionId` resumes a conversation from the agent's
   *  own history instead of starting a fresh one. */
  app.post('/api/mission/projects/:id/sessions', csrfCheck, (req, res) => {
    const project = missionProject(req, res);
    if (!project) return;
    mission
      .startSession(project.id, {
        label: req.body.label,
        origin: req.body.origin,
        agentSessionId: req.body.agentSessionId,
        // Same actor stamp as the MCP path (`key:<id>` there, `user:<id>` here) so
        // a `human` row can be audited later instead of resting on the caller's
        // memory (plan 67, 67.3).
        createdBy: req.session && req.session.userId ? `user:${req.session.userId}` : null,
      })
      .then(({ session, state }) => res.json({ session, state }), (e) => missionFail(res, e));
  });

  /** One session in full: metadata + the pane's live/tuiAlive/cwd state + the
   *  last lines of its screen. This is the shape both the page and
   *  `mission_sessions(session_id)` want. */
  app.get('/api/mission/projects/:id/conversations/:conversationId', (req, res) => {
    const project = missionProject(req, res);
    if (!project) return;
    try {
      const { resolveConversationView } = require('../services/conversation-view');
      res.json(resolveConversationView(project, registry.getAgent(project.agent_name), req.params.conversationId));
    } catch (e) {
      res.status(e.status || 503).json({ error: e.message, code: e.code });
    }
  });

  app.get('/api/mission/sessions/:id', (req, res) => {
    const found = missionSession(req, res);
    if (!found) return;
    mission
      .screen(found.session.id, parseInt(req.query.lines, 10) || 40)
      .then((r) => res.json(r), (e) => missionFail(res, e));
  });

  app.post('/api/mission/sessions/:id/send', csrfCheck, (req, res) => {
    const found = missionSession(req, res);
    if (!found) return;
    mission.sendText(found.session.id, req.body.text, { actor: missionActorFor(req) }).then(
      (r) => res.json({ ok: true, sent: r.sent, project: r.project, session_id: r.session_id, session: r.session, screen: r.screen, confirmed: r.confirmed, acceptance: r.acceptance }),
      (e) => missionFail(res, e)
    );
  });

  /** Answer a permission dialog the pane is parked on (plan 62 1c). The HUMAN's
   *  route, so `always` is allowed here — the durable-policy refusal is the MCP
   *  tool's rule, because that is the machine caller. */
  app.post('/api/mission/sessions/:id/permission', csrfCheck, (req, res) => {
    const found = missionSession(req, res);
    if (!found) return;
    const choice = String(req.body.choice || '');
    if (!['once', 'always', 'reject'].includes(choice)) {
      return res.status(400).json({ error: 'Bad choice', code: 'mission_bad_permission_choice' });
    }
    mission.answerPermission(found.session.id, choice, { allowAlways: true }).then(
      (r) => res.json(r),
      (e) => missionFail(res, e)
    );
  });

  /** Re-launch the TUI in a session whose agent exited (the pane is back at a
   *  shell). Refuses when one is already running. */
  app.post('/api/mission/sessions/:id/relaunch', csrfCheck, (req, res) => {
    const found = missionSession(req, res);
    if (!found) return;
    mission.relaunchTui(found.session.id, { actor: missionActorFor(req) }).then((r) => res.json(r), (e) => missionFail(res, e));
  });

  /** Restart a session whose tmux pane is GONE. Separate from relaunch, which
   *  refuses a dead session: a restart re-creates the same pane rooted at the
   *  project folder and brings back the same agent conversation, keeping the
   *  mission session id. */
  app.post('/api/mission/sessions/:id/restart', csrfCheck, (req, res) => {
    const found = missionSession(req, res);
    if (!found) return;
    mission.restartSession(found.session.id, { actor: missionActorFor(req) }).then((r) => res.json(r), (e) => missionFail(res, e));
  });

  app.patch('/api/mission/sessions/:id', csrfCheck, (req, res) => {
    const found = missionSession(req, res);
    if (!found) return;
    try {
      res.json({ session: mission.updateSession(found.session.id, { label: req.body.label, locked: req.body.locked }) });
    } catch (e) {
      missionFail(res, e);
    }
  });

  app.delete('/api/mission/sessions/:id', csrfCheck, (req, res) => {
    const found = missionSession(req, res);
    if (!found) return;
    mission.closeSession(found.session.id, { actor: missionActorFor(req) }).then(
      () => res.json({ ok: true }),
      (e) => missionFail(res, e)
    );
  });

  app.get('/api/mission/projects/:id/runners', (req, res) => {
    const project = missionProject(req, res);
    if (!project) return;
    try {
      const runners = mission.listRunnersForProject(project.id).map(mission.publicRunner);
      res.json({ runners });
    } catch (e) {
      missionFail(res, e);
    }
  });

  app.post('/api/mission/projects/:id/runners', csrfCheck, async (req, res) => {
    const project = missionProject(req, res);
    if (!project) return;
    if (!canTouchAgent(req, project.agent_name)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    try {
      const runner = await mission.createRunner({
        projectId: project.id,
        name: req.body.name,
        sessionId: req.body.sessionId,
        queueFile: req.body.queueFile,
        actor: missionActorFor(req),
        idleGraceMs: req.body.idleGraceMs,
        minNudgeIntervalMs: req.body.minNudgeIntervalMs,
        noProgressBudget: req.body.noProgressBudget,
        compactionGraceMs: req.body.compactionGraceMs,
        longCommandThresholdMs: req.body.longCommandThresholdMs,
        recoverExited: req.body.recoverExited,
        recoveryBudget: req.body.recoveryBudget,
        promptTemplates: req.body.promptTemplates,
      });
      res.json({ runner: mission.publicRunner(runner) });
    } catch (e) {
      missionFail(res, e);
    }
  });

  /** Project-scoped prompt catalogue for the create dialog (no runner yet):
   *  engine contract only. Same project gate as create. */
  app.get('/api/mission/projects/:id/prompts', async (req, res) => {
    try {
      const project = missionProject(req, res);
      if (!project) return;
      res.json({ ...mission.promptCatalogue(), project: { id: project.id, name: project.name } });
    } catch (e) {
      missionFail(res, e);
    }
  });

  /** Project-scoped preview for the create dialog (no runner yet): the same
   *  engine over the project's real paths; runner name and item values arrive
   *  as caller overrides and are labeled samples. Same project gate as create. */
  app.post('/api/mission/projects/:id/prompts/preview', csrfCheck, async (req, res) => {
    try {
      const project = missionProject(req, res);
      if (!project) return;
      res.json(await mission.previewProjectPrompts(project.id, req.body && req.body.drafts, (req.body && req.body.overrides) || {}));
    } catch (e) {
      missionFail(res, e);
    }
  });

  // ─── API: Mission runner callbacks (plan 92 §Phase 2) ─────────────
  // Settings surface: scripts + enable flags + catalogue. Reads and saves NEVER
  // execute a script — only a fired lifecycle event does (Phase 3 executor). Same
  // runner → project → agent gate as every other runner route.

  app.get('/api/mission/projects/:id/callbacks/catalogue', async (req, res) => {
    try {
      const project = missionProject(req, res);
      if (!project) return;
      res.json({ ...mission.callbackCatalogue(), project: { id: project.id, name: project.name } });
    } catch (e) {
      missionFail(res, e);
    }
  });

  /** Post-destroy owner path: destroy deletes the runner row the runner-scoped
   *  gate reads through, so history is scoped by project + runner id instead.
   *  Same project gate as create. */
  app.get('/api/mission/projects/:id/callbacks/history', async (req, res) => {
    try {
      const project = missionProject(req, res);
      if (!project) return;
      if (!req.query.runnerId) return res.status(400).json({ error: 'runnerId is required', code: 'callback_history_unscoped' });
      res.json({ history: mission.runnerCallbackHistory({ runnerId: req.query.runnerId, projectId: project.id, limit: req.query.limit }) });
    } catch (e) {
      missionFail(res, e);
    }
  });
};
