/**
 * Infinite runners: the runner, its queue, prompts, callbacks and controls.
 */
const mission = require('../services/mission');
const { csrfCheck, requireAdmin } = require('../middleware/auth');

/** Register this area's routes on the app. `ctx` carries the helpers app.js owns. */
module.exports = function register(app, ctx) {
  const {
    canTouchAgent, missionFail, missionActorFor,
  } = ctx;

  /** A runner plus its project, access-checked (plan 85 §Phase 4 gap 8).
   *  Returns { runner, project }. The runner row lives in exactly one project,
   *  so the check runs against that project's agent — the same grant the
   *  project-scoped create/list routes already enforce. */
  function missionRunner(req, res) {
    const runner = mission.getRunner(req.params.id);
    if (!runner) {
      res.status(404).json({ error: 'Runner not found', code: 'runner_not_found' });
      return null;
    }
    let project;
    try {
      project = mission.getProject(runner.project_id);
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message, code: e.code });
      return null;
    }
    if (!canTouchAgent(req, project.agent_name)) {
      res.status(403).json({ error: 'Access denied' });
      return null;
    }
    return { runner, project };
  }

  function missionRunnerResult(result) {
    return result && result.runner
      ? { ...result, runner: mission.publicRunner(result.runner) }
      : result;
  }

  // ─── API: Mission Runners (plan 83) ──────────────────────────

  /** All runners across the caller's projects, each tagged with its project —
   *  the all-projects view merges infinite sessions into one list (plan 85). */
  app.get('/api/mission/runners', (req, res) => {
    try {
      const runners = mission.listAllRunners({ allow: (agentName) => canTouchAgent(req, agentName) }).map(mission.publicRunner);
      res.json({ runners });
    } catch (e) {
      missionFail(res, e);
    }
  });

  app.get('/api/mission/runners/:id', async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      const detail = await mission.readRunnerQueue(found.runner.id);
      res.json({ runner: mission.publicRunner(found.runner), project: detail.project, queue: detail.queue });
    } catch (e) {
      missionFail(res, e);
    }
  });

  /** The runner's queue in full (parsed + enriched items, summary, revision),
   *  plan 86 §Phase 1. The edit UI holds this `revision` and passes it back. */
  app.get('/api/mission/runners/:id/history', async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      const { before, category, limit } = req.query;
      try {
        res.json(require('../services/runner-history').read(found.runner.id, { before: before ?? null, category: category || 'all', limit }));
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
        res.status(400).json({ error: e.message });
      }
    } catch (e) { missionFail(res, e); }
  });

  app.get('/api/mission/runners/:id/history/output/:eventId', async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      const output = require('../services/runner-history').output(found.runner.id, req.params.eventId);
      if (!output) return res.status(404).json({ error: 'Callback output not found for this runner' });
      res.json(output);
    } catch (e) { missionFail(res, e); }
  });

  app.get('/api/mission/runners/:id/queue', async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      res.json(await mission.readRunnerQueue(found.runner.id));
    } catch (e) {
      missionFail(res, e);
    }
  });

  /** Set the queue up: create QUEUE.md from the template when absent, refuse when
   *  the file still will not validate. Creating and editing are separate actions
   *  ("not set up yet" vs "edit my queue") so they get separate routes. */
  app.post('/api/mission/runners/:id/queue', csrfCheck, async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      const detail = await mission.setupRunnerQueue(found.runner.id, {
        actor: missionActorFor(req),
        confirmProjectionReset: req.body?.confirmProjectionReset === true,
      });
      res.json(detail);
    } catch (e) {
      missionFail(res, e);
    }
  });

  /** Canonical queue mutations: the server owns IDs and applies each change under
   * the revision it read. Whole-array writes are deliberately not supported. */
  app.post('/api/mission/runners/:id/queue/items', csrfCheck, async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      if (!Array.isArray(req.body.plans)) {
        return res.status(400).json({ error: 'plans must be an array', code: 'queue_plans_missing' });
      }
      res.json(await mission.addRunnerQueueItems(found.runner.id, req.body.plans, req.body.revision, { actor: missionActorFor(req) }));
    } catch (e) {
      missionFail(res, e);
    }
  });

  app.put('/api/mission/runners/:id/queue/order', csrfCheck, async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      if (!Array.isArray(req.body.itemIds)) {
        return res.status(400).json({ error: 'itemIds must be an array', code: 'queue_order_invalid' });
      }
      res.json(await mission.reorderRunnerQueue(found.runner.id, req.body.itemIds, req.body.revision, { actor: missionActorFor(req) }));
    } catch (e) {
      missionFail(res, e);
    }
  });

  app.delete('/api/mission/runners/:id/queue/items/:itemId', csrfCheck, async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      res.json(await mission.removeRunnerQueueItem(found.runner.id, req.params.itemId, req.body?.revision, { actor: missionActorFor(req) }));
    } catch (e) {
      missionFail(res, e);
    }
  });

  app.patch('/api/mission/runners/:id/queue/items/:itemId', csrfCheck, async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      const { status, reason, revision } = req.body || {};
      if (typeof status !== 'string') return res.status(400).json({ error: 'status must be text', code: 'queue_status_invalid' });
      res.json(await mission.updateRunnerQueueItem(found.runner.id, req.params.itemId,
        { status, ...(reason === undefined ? {} : { reason }) }, revision,
        { actor: missionActorFor(req), source: 'review' }));
    } catch (e) {
      missionFail(res, e);
    }
  });

  /** Revision-protected queue-level guidance. Empty guidance removes the optional
   * field; a nonempty draft may safely create a missing selected queue file. */
  app.put('/api/mission/runners/:id/queue/custom-instructions', csrfCheck, async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      if (typeof req.body.customInstructions !== 'string') {
        return res.status(400).json({ error: 'customInstructions must be a string', code: 'queue_custom_instructions_invalid' });
      }
      res.json(await mission.updateRunnerQueueCustomInstructions(found.runner.id, req.body.customInstructions, req.body.revision, { actor: missionActorFor(req) }));
    } catch (e) {
      missionFail(res, e);
    }
  });

  /** The plans available in this runner's project folder (plan 86 §Phase 3) —
   *  the candidate list for the "Add plans" picker. Same access gate as the
   *  queue routes (runner → project → agent). */
  app.get('/api/mission/runners/:id/plans', async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      res.json(await mission.listRunnerPlans(found.runner.id));
    } catch (e) {
      missionFail(res, e);
    }
  });

  /** One plan file, raw, for the Mission file viewer: read with its content
   *  revision, save only against that revision (409 if the agent changed it
   *  meanwhile). Path is relative to the project's plans folder. */
  app.get('/api/mission/runners/:id/plan-file', (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      res.json(mission.readRunnerPlanFile(found.runner.id, req.query.path));
    } catch (e) {
      missionFail(res, e);
    }
  });

  app.put('/api/mission/runners/:id/plan-file', csrfCheck, (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      res.json(mission.writeRunnerPlanFile(found.runner.id, req.body?.path, req.body?.content, req.body?.revision, { actor: missionActorFor(req) }));
    } catch (e) {
      missionFail(res, e);
    }
  });

  /** Prompt-template configuration surface (plan 91 §Phase 2): catalogue,
   *  shipped defaults and this runner's effective set. Read-only — creates no
   *  session, touches no queue file, enables nothing. Same gate as the rest. */
  app.get('/api/mission/runners/:id/prompts', async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      res.json(mission.runnerPromptConfig(found.runner.id));
    } catch (e) {
      missionFail(res, e);
    }
  });

  /** Read-only preview: validate drafts and render them against a context
   *  without persisting anything. Never sends, starts or enables. */
  app.post('/api/mission/runners/:id/prompts/preview', csrfCheck, async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      res.json(await mission.previewRunnerPrompts(found.runner.id, req.body && req.body.drafts, (req.body && req.body.overrides) || {}));
    } catch (e) {
      missionFail(res, e);
    }
  });
  app.get('/api/mission/runners/:id/callbacks', async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      res.json(mission.getRunnerCallbacks(found.runner.id));
    } catch (e) {
      missionFail(res, e);
    }
  });

  // Callback scripts run as root in the control plane, beside the docker
  // socket (plan 92, deliberately), so only an admin may save or enable one.
  app.put('/api/mission/runners/:id/callbacks', csrfCheck, requireAdmin, async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      res.json(mission.saveRunnerCallbacks(found.runner.id, req.body && req.body.callbacks));
    } catch (e) {
      missionFail(res, e);
    }
  });

  app.get('/api/mission/runners/:id/callbacks/history', async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      res.json({ history: mission.runnerCallbackHistory({ runnerId: found.runner.id, limit: req.query.limit }) });
    } catch (e) {
      missionFail(res, e);
    }
  });

  app.patch('/api/mission/runners/:id', csrfCheck, async (req, res) => {  try {
      const found = missionRunner(req, res);
      if (!found) return;
      const runner = await mission.updateRunner(found.runner.id, {
        name: req.body.name,
        queueFile: req.body.queueFile,
        idleGraceMs: req.body.idleGraceMs,
        minNudgeIntervalMs: req.body.minNudgeIntervalMs,
        noProgressBudget: req.body.noProgressBudget,
        compactionGraceMs: req.body.compactionGraceMs,
        longCommandThresholdMs: req.body.longCommandThresholdMs,
        recoverExited: req.body.recoverExited,
        recoveryBudget: req.body.recoveryBudget,
        // Absent key is `undefined` → preserve; explicit null resets to defaults.
        promptTemplates: req.body.promptTemplates,
      });
      res.json({ runner: mission.publicRunner(runner) });
    } catch (e) {
      missionFail(res, e);
    }
  });

  /** Open a runner's worker session without touching its queue (plan 85 §Phase 1).
   *  Clicking an unbound runner's row creates/binds its session; clicking a dead
   *  one recovers the same conversation. Never enables dispatch, never sends a
   *  prompt — opening a conversation and running its queue are separate actions. */
  app.post('/api/mission/runners/:id/session', csrfCheck, async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      const session = await mission.ensureRunnerSession(found.runner.id, { actor: missionActorFor(req) });
      res.json({ session });
    } catch (e) {
      missionFail(res, e);
    }
  });

  app.post('/api/mission/runners/:id/start', csrfCheck, async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      const result = await mission.startRunner(found.runner.id, { actor: missionActorFor(req) });
      res.json(missionRunnerResult(result));
    } catch (e) {
      missionFail(res, e);
    }
  });

  app.post('/api/mission/runners/:id/pause', csrfCheck, async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      // Plan 86 §Phase 4b: an explicit, validated pause mode. Omitted → the
      // service default (`before_next_task`), preserving the old behavior; an
      // unknown mode is rejected by pauseRunner with runner_invalid_pause_mode.
      const mode = req.body && req.body.mode;
      const runner = await mission.pauseRunner(found.runner.id, {
        mode: mode === undefined ? undefined : mode,
        actor: missionActorFor(req),
      });
      res.json({ runner: mission.publicRunner(runner) });
    } catch (e) {
      missionFail(res, e);
    }
  });

  app.post('/api/mission/runners/:id/resume', csrfCheck, async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      const result = await mission.resumeRunner(found.runner.id, { actor: missionActorFor(req) });
      res.json(missionRunnerResult(result));
    } catch (e) {
      missionFail(res, e);
    }
  });

  app.post('/api/mission/runners/:id/resolve', csrfCheck, async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      const { itemId, answer, revision, idempotencyKey } = req.body || {};
      if (!itemId || !answer) return res.status(400).json({ error: 'itemId and answer are required' });
      const result = await mission.resolveRunnerQueue(found.runner.id, itemId, answer, revision, idempotencyKey, { actor: missionActorFor(req) });
      res.json(result);
    } catch (e) {
      missionFail(res, e);
    }
  });

  app.post('/api/mission/runners/:id/reconcile', csrfCheck, async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      const result = await mission.reconcileRunnerOperation(found.runner.id, { actor: missionActorFor(req) });
      res.json(result);
    } catch (e) {
      missionFail(res, e);
    }
  });

  app.delete('/api/mission/runners/:id', csrfCheck, async (req, res) => {
    try {
      const found = missionRunner(req, res);
      if (!found) return;
      await mission.removeRunner(found.runner.id, { actor: missionActorFor(req) });
      res.json({ removed: true });
    } catch (e) {
      missionFail(res, e);
    }
  });
};
