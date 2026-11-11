/**
 * PAD listing and lifecycle: create, start, stop, restart, recreate, update,
 * delete, logs, stats and exec.
 */
const fs = require('fs');
const path = require('path');
const registry = require('../services/agent-registry');
const vm = require('../services/vm-manager');
const drivers = require('../services/drivers');
const jobLog = require('../services/job-log');
const logStore = require('../services/log-store');
const { getDb } = require('../services/db');

/** Register this area's routes on the app. `ctx` carries the helpers app.js owns. */
module.exports = function register(app, ctx) {
  const {
    PREFIX, INSTANCES_DIR, readMeta, dockerPsList, getVmStatus, safeVmName, runCmd,
    termUserArgs, dockerExec,
  } = ctx;

  const PREFIX_DASH = PREFIX + '-';

  async function getAllVms() {
    const vms = [];
    if (!fs.existsSync(INSTANCES_DIR)) return vms;
    const dirs = fs.readdirSync(INSTANCES_DIR).sort();
    for (const d of dirs) {
      if (!d.startsWith(PREFIX_DASH)) continue;
      const stat = fs.statSync(path.join(INSTANCES_DIR, d));
      if (!stat.isDirectory()) continue;
      const meta = readMeta(d);
      const agent = meta.AGENT || 'openclaw';
      const containers = await dockerPsList();
      const cinfo = containers[d] || {};
      vms.push({
        name: d,
        agent,
        password: meta.ROOT_PASSWORD || '',
        port: meta.PORT || '',
        status: getVmStatus(d),
        container_status: cinfo.Status || '',
        config_exists: fs.existsSync(path.join(INSTANCES_DIR, d, agent, 'openclaw.json')),
      });
    }
    return vms;
  }

  // ─── Routes: API ────────────────────────────────────────────

  app.get('/api/vms', async (req, res) => {
    res.json(await getAllVms());
  });

  app.get('/api/agents', (req, res) => {
    const ownerId = req.session.role === 'admin' ? null : req.session.userId;
    const agents = registry.discoverAgents(ownerId);
    const stats = registry.getAgentStats(ownerId);
    const orphans = req.session.role === 'admin' ? registry.getOrphanCount() : 0;
    res.json({ agents, stats, orphans });
  });

  app.post('/api/agents/:name/assign', (req, res) => {
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { owner_id } = req.body;
    if (!owner_id) return res.status(400).json({ error: 'owner_id required' });
    try {
      const db = getDb();
      const user = db.prepare('SELECT id FROM users WHERE id = ?').get(owner_id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      db.prepare('UPDATE agents SET owner_id = ? WHERE name = ?').run(owner_id, req.params.name);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/agents/:name/start', async (req, res) => {
    const name = req.params.name;
    registry.setLifecycle(name, 'starting');
    try {
      await vm.startAgent(name);
    } finally {
      registry.setLifecycle(name, null);
    }
    registry.dockerPsList(true);
    const agent = registry.getAgent(req.params.name);
    res.json({ ok: true, status: agent ? agent.status : 'running' });
  });

  app.post('/api/agents/:name/stop', async (req, res) => {
    const name = req.params.name;
    registry.setLifecycle(name, 'stopping');
    try {
      await vm.stopAgent(name);
    } finally {
      registry.setLifecycle(name, null);
    }
    registry.dockerPsList(true);
    const agent = registry.getAgent(req.params.name);
    res.json({ ok: true, status: agent ? agent.status : 'exited' });
  });

  app.post('/api/agents/:name/restart', async (req, res) => {
    const name = req.params.name;
    registry.setLifecycle(name, 'restarting');
    try {
      await vm.restartAgent(name);
    } finally {
      registry.setLifecycle(name, null);
    }
    registry.dockerPsList(true);
    const agent = registry.getAgent(req.params.name);
    res.json({ ok: true, status: agent ? agent.status : 'running' });
  });

  app.post('/api/agents/:name/delete', async (req, res) => {
    if (!safeVmName(req.params.name)) return res.status(400).json({ error: 'Invalid name' });
    try {
      await logStore.capture(req.params.name);
      await vm.removeVm(req.params.name);
      registry.removeAgentFromDb(req.params.name);
      jobLog.clearJob(req.params.name);
      jobLog.clearJob('update:' + req.params.name);
      registry.dockerPsList(true);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Agent Settings / Update ────────────────────────────────

  /** All containers visible to the webui — the Network dropdown source. */
  app.get('/api/containers', async (req, res) => {
    try {
      const containers = await dockerPsList();
      const list = Object.values(containers)
        .map((c) => ({
          name: Array.isArray(c.Names) ? String(c.Names[0] || '').replace(/^\//, '') : String(c.Names || c.ID || '').replace(/^\//, ''),
          image: c.Image || '',
          state: (c.State || '').toLowerCase(),
        }))
        .filter((c) => c.name && !vm.isManagedDoorContainer(c.name));
      res.json({ containers: list });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/agents/:name/recreate', async (req, res) => {
    const name = safeVmName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Invalid agent name' });
    const { pull = false, reset = false } = req.body || {};
    try {
      const meta = readMeta(name);
      if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });

      const jobKey = 'update:' + name;
      const job = jobLog.getOrCreateJob(jobKey);
      const log = (stream, text) => jobLog.line(job, stream, text);
      const step = (stepName, state, cmd) => jobLog.setStep(job, stepName, state, cmd);

      res.status(202).json({ ok: true, job: jobKey, streaming: true, reason: 'recreate' });

      setImmediate(async () => {
        registry.setRestarting(name, true);
        try {
          await logStore.capture(name);
          // Reuse the consolidated mutation flow so every persisted option and
          // the owned forwarding door survive a Settings recreate. `force: true`
          // makes a bare recreate (nothing changed) still stop + force-recreate
          // the container and its door — otherwise it would be a no-op.
          await vm.applyAgentChanges(name, { pull, reset, force: true }, { onLog: log, onStep: step });
          if (pull) {
            try {
              const v = await drivers.getDriverOr(meta.AGENT).currentVersion(name);
              if (v) vm.setMetaFlag(name, 'OPENCLAW_VERSION', v);
            } catch {}
          }
          registry.dockerPsList(true);
          registry.discoverAgents();
          try {
            const reason = reset
              ? 'User data reset and container recreated'
              : pull
                ? 'Image updated and container recreated'
                : 'Container recreated (network peer re-resolved)';
            registry.recordActivity(name, 'settings', 'recreate', 'ok', reason);
          } catch {}
          log('system', 'Done — container recreated');
          jobLog.finish(job, true);
        } catch (e) {
          console.error(`Recreate failed for ${name}:`, e.message);
          try {
            registry.recordActivity(name, 'settings', 'recreate', 'error', e.message);
          } catch {}
          jobLog.fail(job, e.message);
        } finally {
          registry.setRestarting(name, false);
        }
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/agents/:name/update', async (req, res) => {
    const name = safeVmName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Invalid agent name' });
    const meta = readMeta(name);
    if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });

    const jobKey = 'update:' + name;
    const job = jobLog.getOrCreateJob(jobKey);
    const log = (stream, text) => jobLog.line(job, stream, text);
    const step = (stepName, state, cmd) => jobLog.setStep(job, stepName, state, cmd);

    res.status(202).json({ ok: true, job: jobKey, streaming: true });

    setImmediate(async () => {
      try {
        await logStore.capture(name);
        await vm.updateAgent(name, {
          onLog: log,
          onStep: (stepName, state) => {
            step(stepName, state);
            // The old container stays up through the build; only during the
            // recreate is it actually down. Report `restarting` for that window.
            if (stepName === 'recreate') {
              if (state === 'start') registry.setRestarting(name, true);
              else if (state === 'end' || state === 'error') registry.setRestarting(name, false);
            }
          },
        });
        registry.dockerPsList(true);
        registry.discoverAgents();
        try {
          const meta = readMeta(name);
          const v = await drivers.getDriverOr(meta.AGENT).currentVersion(name);
          if (v) vm.setMetaFlag(name, 'OPENCLAW_VERSION', v);
        } catch {}
        jobLog.line(job, 'system', 'Done — container recreated');
        jobLog.finish(job, true);
        try {
          registry.recordActivity(name, 'lifecycle', 'update', 'ok', 'Image updated and container recreated');
        } catch {}
      } catch (e) {
        console.error(`Update failed for ${name}:`, e.message);
        try {
          registry.recordActivity(name, 'lifecycle', 'update', 'error', e.message);
        } catch {}
        jobLog.fail(job, e.message);
      } finally {
        registry.setRestarting(name, false);
      }
    });
  });

  app.get('/api/agents/:name/update-log', (req, res) => {
    const name = safeVmName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Invalid agent name' });
    const since = parseInt(req.headers['last-event-id'], 10) || Math.max(0, parseInt(req.query.since, 10) || 0);
    const job = jobLog.getJob('update:' + name);

    if (!job) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'Update job not found (server may have restarted)' })}\n\n`);
      res.end();
      return;
    }

    jobLog.subscribe(job, res, since);
  });

  // ─── Agent API ──────────────────────────────────────────────

  app.get('/api/agents/:name', (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(agent);
  });

  app.get('/api/agents/stats/fleet', async (req, res) => {
    try {
      const r = await runCmd('docker', ['stats', '--no-stream', '--format', '{{json .}}']);
      const lines = r.stdout.trim().split('\n').filter(Boolean);
      const all = lines.map(l => JSON.parse(l));
      const prefix = process.env.CONTAINER_PREFIX || 'pad';
      const stats = all.filter(s => s.Name && s.Name.startsWith(prefix + '-'));
      res.json({ stats });
    } catch { res.json({ stats: [] }); }
  });

  app.get('/api/agents/:name/stats', async (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    try {
      const r = await runCmd('docker', ['stats', agent.runtime_ref, '--no-stream', '--format', '{{json .}}']);
      res.json({ stats: JSON.parse(r.stdout.trim()) });
    } catch { res.json({ stats: null }); }
  });

  app.get('/api/agents/:name/logs', async (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const tail = Math.min(parseInt(req.query.tail) || 100, 5000);
    try {
      await logStore.capture(agent.name);
      const logs = logStore.readLogs(agent.name, tail);
      res.json({ logs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/agents/:name/activity', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const activity = registry.getActivity(req.params.name, limit);
    res.json({ activity });
  });

  app.post('/api/agents/:name/command-log', (req, res) => {
    const { cmd, status, ts } = req.body || {};
    if (!cmd || typeof cmd !== 'string' || !cmd.trim()) {
      return res.status(400).json({ error: 'cmd required' });
    }
    try {
      registry.recordActivity(
        req.params.name,
        'command',
        'run',
        status === 'error' ? 'error' : 'ok',
        cmd.trim(),
        ts || null
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });


  // ─── API: Create Agent ──────────────────────────────────────

  app.post('/api/agents/create', async (req, res) => {
    const { name, agent, assign_to, workspace_host, workspace_dir, allowDocker, network, sshEnabled, port, sshContainerPort, password, extraVolumes, extraPorts, userMode, buildCommands, postCreate, postStart, postAttach, generateDevContainer } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!safeVmName(name)) return res.status(400).json({ error: `Invalid pad name — use ${PREFIX}-<name> (letters, digits, _ or -), e.g. ${PREFIX}-dev`, code: 'invalid_pad_name' });
    if (registry.getAgent(name)) return res.status(409).json({ error: 'Agent already exists' });

    // Shared pre-flight (plan 30): the same vm.validateAgentCreate that backs the
    // MCP create_agent tool — network peer exists/running, extra volumes/ports,
    // SSH container port, workspace mount, and cross-agent host-port availability
    // all abort with 400 BEFORE the 202 is emitted.
    const agentType = agent || 'openclaw';
    try {
      await vm.validateAgentCreate(name, {
        agent: agentType,
        sshEnabled: !!sshEnabled,
        port,
        sshContainerPort,
        workspaceHost: workspace_host,
        workspaceDir: workspace_dir,
        network: network || '',
        extraVolumes,
        extraPorts,
        userMode: userMode === 'user' ? 'user' : '',
      });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const job = jobLog.getOrCreateJob(name);
    const log = (stream, text) => jobLog.line(job, stream, text);
    const step = (stepName, state, cmd) => jobLog.setStep(job, stepName, state, cmd);

    // Respond immediately; the create runs in the background and streams its
    // output to the SSE endpoint (GET /api/agents/:name/create-log).
    res.status(202).json({ ok: true, job: name, streaming: true });

    setImmediate(async () => {
      try {
        await vm.createAgent(name, {
          agent: agentType,
          workspaceHost: workspace_host,
          workspaceDir: workspace_dir,
          allowDocker: !!allowDocker,
          network: network || '',
          sshEnabled: !!sshEnabled,
          port,
          sshContainerPort,
          password: typeof password === 'string' ? password : '',
          extraVolumes,
          extraPorts,
          userMode: userMode === 'user' ? 'user' : '',
          buildCommands: typeof buildCommands === 'string' ? buildCommands : '',
          postCreate: typeof postCreate === 'string' ? postCreate : '',
          postStart: typeof postStart === 'string' ? postStart : '',
          postAttach: typeof postAttach === 'string' ? postAttach : '',
          generateDevContainer: generateDevContainer !== false,
          onLog: log,
          onStep: step,
        });
        registry.discoverAgents();

        // Set owner_id in DB (admin may re-assign to another user)
        try {
          const db = getDb();
          let ownerId = req.session.userId;
          if (assign_to && req.session.role === 'admin') {
            const user = db.prepare('SELECT id FROM users WHERE id = ?').get(assign_to);
            if (user) ownerId = assign_to;
          }
          registry.assignOwner(name, ownerId);
        } catch {}

        registry.recordActivity(name, 'lifecycle', 'create', 'ok', `Agent created (type=${agentType})`);
        jobLog.finish(job, true);
      } catch (e) {
        console.error(`Create failed for ${name}:`, e.message);
        // The agent may not exist in the agents table yet (createVm failed before
        // the registry sync), so recordActivity can hit an FK violation and crash
        // the whole process. Guard it.
        try {
          registry.dockerPsList(true);
          registry.discoverAgents();
          registry.recordActivity(name, 'lifecycle', 'create', 'error', e.message);
        } catch (auditErr) {
          console.error('Failed to record create error activity:', auditErr.message);
        }
        jobLog.fail(job, e.message);
      }
    });
  });

  // ─── API: Create Agent — live log stream (SSE) ──────────────

  app.get('/api/agents/:name/create-log', (req, res) => {
    const name = safeVmName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Invalid agent name' });

    const since = parseInt(req.headers['last-event-id'], 10) || Math.max(0, parseInt(req.query.since, 10) || 0);
    const job = jobLog.getJob(name);

    if (!job) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      // No job (or already cleaned up): send a terminal "gone" event.
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'Create job not found (server may have restarted)' })}\n\n`);
      res.end();
      return;
    }

    jobLog.subscribe(job, res, since);
  });

  // ─── API: Create Agent — status poll (fallback) ─────────────

  app.get('/api/agents/:name/create-status', (req, res) => {
    const name = safeVmName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Invalid agent name' });
    const status = jobLog.getStatus(name);
    if (!status) return res.json({ done: false, found: false });
    res.json({ found: true, ...status });
  });

  // ─── API: Onboard Agent ─────────────────────────────────────

  app.post('/api/agents/:name/onboard', async (req, res) => {
    const name = req.params.name;
    const { bot_token, user_id, api_key_provider, api_key_value } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });

    try {
      if (bot_token) {
        await runCmd('docker', ['exec', ...termUserArgs(name), name, 'openclaw', 'channels', 'add', '--channel', 'telegram', '--token', bot_token], { timeout: 30000 });
        await runCmd('docker', ['exec', ...termUserArgs(name), name, 'openclaw', 'config', 'set', 'channels.telegram.allowFrom', JSON.stringify([user_id || process.env.DEFAULT_ALLOW_FROM || '532156945'])], { timeout: 15000 });
        await runCmd('docker', ['exec', ...termUserArgs(name), name, 'openclaw', 'config', 'set', 'channels.telegram.dmPolicy', 'allowlist'], { timeout: 15000 });
      }
      if (api_key_provider && api_key_value) {
        await runCmd('docker', ['exec', '-i', ...termUserArgs(name), name, 'openclaw', 'models', 'auth', 'paste-api-key', '--provider', api_key_provider], { input: api_key_value, timeout: 30000 });
      }
      res.json({ ok: true, message: 'Onboard complete' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── API: Exec ──────────────────────────────────────────────

  app.post('/api/agents/:name/exec', async (req, res) => {
    const name = req.params.name;
    const { command, timeout } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
    if (!command) return res.status(400).json({ error: 'Command is required' });

    try {
      const containers = await dockerPsList();
      if ((containers[name]?.State || '').toLowerCase() !== 'running')
        return res.status(400).json({ error: 'Container is not running' });

      const r = await dockerExec(name, command, timeout || 30000);
      res.json({ stdout: r.stdout, stderr: r.stderr });
    } catch (e) {
      res.status(500).json({ error: e.message, stderr: e.stderr || '' });
    }
  });
};
