/**
 * What is wired into one PAD: MCP servers, skills, channels, terminal sessions
 * and its orchestrator grant.
 */
const registry = require('../services/agent-registry');
const orchestrator = require('../services/orchestrator');
const mission = require('../services/mission');
const padTmux = require('../services/pad-tmux');
const { getDb } = require('../services/db');
const { csrfCheck } = require('../middleware/auth');

/** Register this area's routes on the app. `ctx` carries the helpers app.js owns. */
module.exports = function register(app, ctx) {
  const {
    opencodePanes, opencodeSessionTitle, safeVmName, dockerExec, dockerPsList, ensureSqlite3,
    safeSessionName, canTouchAgent, missionFail,
  } = ctx;

  async function listTmuxSessions(vmName, agentType = '') {
    // The tmux call itself is pad-tmux's (one implementation, tested); only the
    // opencode title-stamping below is terminal-specific.
    const sessions = await padTmux.listSessions(vmName);
    // Only sessions actually running the opencode TUI carry the `OC | …` title.
    // opencode_web creates sessions too, so the "latest session" title must
    // never be stamped onto a pane that isn't running the TUI (see opencodePanes).
    if (agentType === 'opencode') {
      try {
        const openPanes = await opencodePanes(vmName);
        let t = '';
        if (openPanes.size) t = await opencodeSessionTitle(vmName) || '';
        if (t) t = 'OC | ' + t;
        for (const s of sessions) if (openPanes.has(s.name)) s.title = t;
      } catch {}
    }
    return sessions;
  }

  async function killTmuxSession(vmName, session) {
    return padTmux.killSession(vmName, session);
  }

  // ─── API: MCP Servers ────────────────────────────────────────

  app.get('/api/agents/:name/mcp', async (req, res) => {
    const name = req.params.name;
    if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
    const agent = registry.getAgent(name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    try {
      const { stdout, code } = await dockerExec(name, 'cat /root/.openclaw/openclaw.json', 5000);
      if (code !== 0) return res.json({ servers: [] });
      const raw = JSON.parse(stdout);
      const mcpServers = (raw.mcp && raw.mcp.servers) || {};
      const entries = Object.entries(mcpServers).map(([name, cfg]) => ({
        name, cfg,
        transport: cfg.transport || (cfg.url ? 'streamable-http' : 'stdio'),
        command: cfg.url || [cfg.command, ...(cfg.args || [])].filter(Boolean).join(' '),
        enabled: cfg.enabled !== false,
      }));

      // Quick curl reachability check for HTTP servers
      const httpServers = entries.filter((e) => e.cfg.url);
      const statusMap = {};
      if (httpServers.length > 0) {
        const results = await Promise.all(
          httpServers.map((s) =>
            dockerExec(name, `curl -sI --connect-timeout 5 ${s.cfg.url}`, 10000)
              .then((r) => ({ name: s.name, ok: r.code === 0 }))
              .catch(() => ({ name: s.name, ok: false }))
          )
        );
        for (const r of results) statusMap[r.name] = r.ok;
      }

      const servers = entries.map(({ name, transport, command, enabled }) => ({
        name, transport, command, enabled,
        ok: name in statusMap ? statusMap[name] : null,
      }));
      res.json({ servers });
    } catch (e) {
      res.json({ servers: [], error: e.message });
    }
  });

  app.post('/api/agents/:name/mcp/add', async (req, res) => {
    const name = req.params.name;
    if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
    const agent = registry.getAgent(name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const { name: serverName, command, args, url, transport, cwd, env, auth, timeout } = req.body;
    if (!serverName) return res.status(400).json({ error: 'name required' });

    const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    let cmdStr = `openclaw mcp add --no-probe ${sq(serverName)}`;
    if (transport === 'streamable-http' || url) {
      cmdStr += ` --url ${sq(url || '')}`;
      if (transport) cmdStr += ` --transport ${sq(transport)}`;
    } else {
      if (command) cmdStr += ` --command ${sq(command)}`;
      if (args && Array.isArray(args)) {
        for (const a of args) cmdStr += ` --arg ${sq(a)}`;
      }
    }
    if (cwd) cmdStr += ` --cwd ${sq(cwd)}`;
    if (env && typeof env === 'object') {
      for (const [k, v] of Object.entries(env)) cmdStr += ` --env ${sq(`${k}=${v}`)}`;
    }
    if (auth === 'oauth') cmdStr += ` --auth oauth`;
    if (timeout) cmdStr += ` --timeout ${sq(String(timeout))}`;
    try {
      const { code, stderr } = await dockerExec(name, cmdStr, 30000);
      if (code !== 0) {
        return res.status(500).json({ error: stderr || 'Server add command failed' });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/agents/:name/mcp/remove', async (req, res) => {
    const name = req.params.name;
    if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
    const { name: serverName } = req.body;
    if (!serverName) return res.status(400).json({ error: 'name required' });
    const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    try {
      const { code, stderr } = await dockerExec(name, `openclaw mcp unset ${sq(serverName)}`);
      if (code !== 0) {
        return res.status(500).json({ error: stderr || 'Remove command failed' });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/agents/:name/mcp/toggle', async (req, res) => {
    const name = req.params.name;
    if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
    const agent = registry.getAgent(name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const { name: serverName, enabled } = req.body;
    if (!serverName || typeof enabled !== 'boolean') return res.status(400).json({ error: 'name and enabled required' });
    try {
      const flag = enabled ? '--enable' : '--disable';
      await dockerExec(name, `openclaw mcp configure ${serverName} ${flag}`);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Lightweight URL reachability check for MCP add form
  app.post('/api/agents/:name/mcp/test-url', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    try {
      const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      res.json({ ok: true, status: response.status });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  app.post('/api/agents/:name/mcp/probe', async (req, res) => {
    const name = req.params.name;
    if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
    const { name: serverName } = req.body;
    let cmd = 'openclaw mcp probe --json';
    if (serverName) cmd = `openclaw mcp probe ${serverName} --json`;
    try {
      const { stdout, code } = await dockerExec(name, cmd, 30000);
      if (code !== 0) return res.status(500).json({ error: 'Probe failed' });
      const data = JSON.parse(stdout);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── API: Skills ──────────────────────────────────────────

  const skillsCache = { ts: 0, data: {} };

  app.get('/api/agents/:name/skills', async (req, res) => {
    const name = req.params.name;
    if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
    const agent = registry.getAgent(name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const now = Date.now();
    const cached = skillsCache.data[name];
    if (cached && now - skillsCache.ts < 30000) return res.json(cached);

    try {
      const [listR, checkR] = await Promise.all([
        dockerExec(name, 'openclaw skills list --json', 30000),
        dockerExec(name, 'openclaw skills check --json', 30000),
      ]);
      const skills = listR.code === 0 ? JSON.parse(listR.stdout).skills || [] : [];
      const check = checkR.code === 0 ? JSON.parse(checkR.stdout) : { ok: false };
      skillsCache.data[name] = { skills, check };
      skillsCache.ts = now;
      res.json({ skills, check });
    } catch (e) {
      res.json(cached || { skills: [], check: { ok: false }, error: e.message });
    }
  });

  app.get('/api/agents/:name/skills/info', async (req, res) => {
    const name = req.params.name;
    if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
    const slug = req.query.name;
    if (!slug) return res.status(400).json({ error: 'name query param required' });
    const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    try {
      const { stdout, code } = await dockerExec(name, `openclaw skills info ${sq(slug)} --json`, 15000);
      if (code !== 0) return res.status(500).json({ error: 'Skill not found' });
      res.json(JSON.parse(stdout));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agents/:name/skills/install', async (req, res) => {
    const name = req.params.name;
    if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
    const { ref, source, as, force } = req.body;
    if (!ref) return res.status(400).json({ error: 'ref required' });
    const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    let cmd = `openclaw skills install ${sq(ref)}`;
    if (source === 'git') cmd = `openclaw skills install git:${sq(ref)}`;
    else if (source === 'local') cmd = `openclaw skills install ${sq(ref)}`;
    if (as) cmd += ` --as ${sq(as)}`;
    if (force) cmd += ' --force';
    try {
      const { code, stderr } = await dockerExec(name, cmd, 30000);
      if (code !== 0) return res.status(500).json({ error: stderr || 'Install failed' });
      skillsCache.data[name] = null;
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agents/:name/skills/remove', async (req, res) => {
    const name = req.params.name;
    if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
    const { slug } = req.body;
    if (!slug) return res.status(400).json({ error: 'slug required' });
    const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    try {
      const { code, stderr } = await dockerExec(name, `rm -rf /root/.openclaw/workspace/skills/${sq(slug)}`, 10000);
      if (code !== 0) return res.status(500).json({ error: stderr || 'Remove failed' });
      skillsCache.data[name] = null;
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agents/:name/skills/update', async (req, res) => {
    const name = req.params.name;
    if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
    const { slug } = req.body;
    const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    const cmd = slug ? `openclaw skills update ${sq(slug)}` : 'openclaw skills update --all';
    try {
      const { code, stderr } = await dockerExec(name, cmd, 30000);
      if (code !== 0) return res.status(500).json({ error: stderr || 'Update failed' });
      skillsCache.data[name] = null;
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agents/:name/skills/verify', async (req, res) => {
    const name = req.params.name;
    if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
    const { slug } = req.body;
    if (!slug) return res.status(400).json({ error: 'slug required' });
    const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    try {
      const { stdout, code } = await dockerExec(name, `openclaw skills verify ${sq(slug)} --json`, 30000);
      if (code !== 0) return res.status(500).json({ error: 'Verify failed' });
      res.json(JSON.parse(stdout));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/agents/:name/sessions', (req, res) => {
    const db = getDb();
    const sessions = db.prepare('SELECT * FROM sessions WHERE agent_id = ? ORDER BY started_at DESC LIMIT 50').all(req.params.name);
    res.json({ sessions });
  });

  app.get('/api/agents/:name/terminal-sessions', async (req, res) => {
    const name = req.params.name;
    if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid name' });
    const containers = await dockerPsList();
    if ((containers[name]?.State || '').toLowerCase() !== 'running') {
      return res.json({ sessions: [] });
    }
    try {
      let agentType = '';
      try { agentType = (registry.getAgent(name) || {}).agent_type || ''; } catch {}
      if (agentType === 'opencode') {
        // Make sqlite3 available for the title query (no-op on modern images).
        try { await ensureSqlite3(name); } catch {}
      }
      res.json({ sessions: await listTmuxSessions(name, agentType) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/agents/:name/terminal-sessions/:id', async (req, res) => {
    const name = req.params.name;
    const id = safeSessionName(req.params.id);
    if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid name' });
    try {
      await killTmuxSession(name, id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/agents/:name/mission-folders', async (req, res) => {
    // Folder picker for the project dialog. Read-only (a GET), but still
    // owner-checked: it runs a container command on a named agent.
    if (!canTouchAgent(req, req.params.name)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    try {
      res.json(await mission.projectFolders(req.params.name, req.query.path || ''));
    } catch (e) {
      missionFail(res, e);
    }
  });

  // ─── Routes: Orchestrator conferral (plan 52 Phase D) ─────────

  /** Ownership gate for orchestra routes: 404 when the pad does not exist, 403
   *  when the caller neither owns it nor is an admin. */
  function requireOwnedAgent(req, res) {
    const row = getDb().prepare('SELECT owner_id FROM agents WHERE name = ?').get(req.params.name);
    if (!row) {
      res.status(404).json({ error: `Agent not found: ${req.params.name}` });
      return false;
    }
    if (req.session.role === 'admin') return true;
    if (row.owner_id === req.session.userId) return true;
    res.status(403).json({ error: 'Access denied' });
    return false;
  }

  function orchestratorFail(res, e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code || 'orchestrator_error' });
  }

  app.get('/api/agents/:name/orchestrator', (req, res) => {
    if (!requireOwnedAgent(req, res)) return;
    try {
      res.json(orchestrator.getOrchestrator(req.params.name, req.session.userId));
    } catch (e) {
      orchestratorFail(res, e);
    }
  });

  app.post('/api/agents/:name/orchestrator', csrfCheck, async (req, res) => {
    if (!requireOwnedAgent(req, res)) return;
    try {
      res.json(await orchestrator.confer(req.params.name, req.session.userId));
    } catch (e) {
      orchestratorFail(res, e);
    }
  });

  app.delete('/api/agents/:name/orchestrator', csrfCheck, async (req, res) => {
    if (!requireOwnedAgent(req, res)) return;
    try {
      res.json(await orchestrator.removeConferral(req.params.name, req.session.userId));
    } catch (e) {
      orchestratorFail(res, e);
    }
  });

  // ─── API: Channels ──────────────────────────────────────────

  app.get('/api/agents/:name/channels-status', async (req, res) => {
    const name = req.params.name;
    const agent = registry.getAgent(name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    try {
      const { stdout, code } = await dockerExec(name, 'openclaw channels status --json', 15000);
      if (code !== 0) return res.json({ channels: {} });
      try { res.json(JSON.parse(stdout)); } catch { res.json({ channels: {} }); }
    } catch (e) {
      res.json({ channels: {}, error: e.message });
    }
  });

  const channelsCache = { ts: 0, data: {} };
  const CHANNELS_CACHE_TTL = 600000;   // 10 minutes

  app.get('/api/agents/:name/channels-list', async (req, res) => {
    const name = req.params.name;
    const agent = registry.getAgent(name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const now = Date.now();
    const force = req.query.refresh === 'true';
    const cached = channelsCache.data[name];
    if (!force && cached && now - channelsCache.ts < CHANNELS_CACHE_TTL) return res.json(cached);

    try {
      const { stdout, code } = await dockerExec(name, 'openclaw channels list --all --json', 15000);
      if (code !== 0) return res.json(cached || { channels: [] });
      const data = JSON.parse(stdout);
      channelsCache.data[name] = data;
      channelsCache.ts = now;
      res.json(data);
    } catch (e) {
      res.json(cached || { channels: [], error: e.message });
    }
  });

  app.post('/api/agents/:name/channels/remove', async (req, res) => {
    const name = req.params.name;
    if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid name' });
    const { channel } = req.body;
    if (!channel) return res.status(400).json({ error: 'channel required' });
    const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    try {
      const { code, stderr } = await dockerExec(name, `openclaw channels remove --channel ${sq(channel)} --delete`, 30000);
      if (code !== 0) return res.status(500).json({ error: stderr || 'Remove failed' });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
