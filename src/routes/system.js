/**
 * Host-level settings: path probing, the .env editor, agent types and admin.
 */
const fs = require('fs');
const vm = require('../services/vm-manager');
const drivers = require('../services/drivers');
const { getPaddockMcpUrl } = require('../services/paddock-mcp');
const { requireAdmin } = require('../middleware/auth');
const pathProbe = require('../services/path-probe');

/** Register this area's routes on the app. `ctx` carries the helpers app.js owns. */
module.exports = function register(app, ctx) {
  const {
    PREFIX, ENV_FILE, writeEnvFile, dockerClient, runCmd,
  } = ctx;

  app.get('/api/paths/probe', (req, res) => {
    try {
      res.json(pathProbe.probe(String(req.query.path || '')));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/paths/autocomplete', (req, res) => {
    try {
      res.json(pathProbe.autocomplete(String(req.query.q || '')));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** Volumes exposed by a workspace folder's project (compose file + running
   *  container supplement), normalized for the Create Agent form's volume
   *  pre-fill (plan 40, D2/D4/D6). */
  app.get('/api/paths/volumes', async (req, res) => {
    try {
      res.json(await pathProbe.discoverVolumes(String(req.query.path || '')));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** The workspace folder's devcontainer.json (plan 41), parsed into the spec's
   *  field set so the Create Agent form can pre-fill the post-create box. */
  app.get('/api/paths/devcontainer', async (req, res) => {
    try {
      const dir = String(req.query.path || '');
      if (!dir) return res.status(400).json({ error: 'path is required' });
      const dc = require('../services/devcontainer');
      const probed = pathProbe.containerPathOf(dir);
      const parsed = dc.readDevContainer(probed);
      if (!parsed) return res.json({ found: false, path: probed });
      res.json({
        found: true,
        path: probed,
        filePath: parsed.filePath,
        name: parsed.name,
        generated: parsed.generated,
        postCreateCommand: parsed.postCreateCommand,
        onCreateCommand: parsed.onCreateCommand,
        updateContentCommand: parsed.updateContentCommand,
        postStartCommand: parsed.postStartCommand,
        postAttachCommand: parsed.postAttachCommand,
        workspaceFolder: parsed.workspaceFolder,
        forwardPorts: parsed.forwardPorts || [],
        image: parsed.image,
        hasBuild: !!(parsed.dockerFile || parsed.buildContext),
        remoteUser: parsed.remoteUser,
        containerUser: parsed.containerUser,
        // item 17: the devcontainer's declared user → the pad Container user
        // default (non-root → 'user'). The explicit toggle in the form wins.
        userMode: parsed.preferredUserMode || '',
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/config', (req, res) => {
    res.json({
      containerPrefix: PREFIX,
      hostWorkspaceRoot: vm.HOST_WORKSPACE || process.env.HOST_WORKSPACE_ROOT || '',
      workspaceRoot: vm.WORKSPACE || process.env.WORKSPACE_ROOT || '/workspace',
      host: process.env.HOST_NAME || '',
      hostProtocol: process.env.HOST_PROTO || 'http',
    });
  });

  // ─── Environment config management ──────────────────────────────

  const ENV_SECRET_KEYS = new Set(['SESSION_SECRET', 'VAULT_KEY', 'AUTH_PASSWORD']);
  const ENV_LOCKED_KEYS = new Set(['VAULT_KEY']);
  const ENV_RECREATE_KEYS = new Set([
    'CONTAINER_PREFIX', 'HOST_NAME', 'HOST_PROTO', 'HOST_WORKSPACE_ROOT',
  ]);
  const ENV_RESTART_KEYS = new Set([
    'AUTO_LOGIN', 'SESSION_SECRET', 'AUTH_PASSWORD',
    'PUID', 'PGID', 'DOCKER_GID',
    'GUARD_PROJECT_ROOT', 'GUARD_INSTANCES_PARENT', 'GUARD_AGENT_DATA',
  ]);
  const ENV_AGENT_KEYS = new Set([
    'DEFAULT_MODEL_BASE_URL', 'DEFAULT_MODEL_NAME', 'DEFAULT_CONTEXT_LENGTH',
    'DEFAULT_ALLOW_FROM',
  ]);
  const ENV_READONLY_KEYS = new Set(['TZ']);

  function readEnvFile() {
    if (!fs.existsSync(ENV_FILE)) return [];
    return fs.readFileSync(ENV_FILE, 'utf8').split('\n');
  }

  function envVarImpact(key) {
    if (ENV_RECREATE_KEYS.has(key)) return 'recreate';
    if (ENV_RESTART_KEYS.has(key)) return 'restart';
    if (ENV_LOCKED_KEYS.has(key)) return 'locked';
    if (ENV_READONLY_KEYS.has(key)) return 'readonly';
    if (ENV_AGENT_KEYS.has(key)) return 'agent';
    return 'agent';
  }

  app.get('/api/env', (req, res) => {
    const lines = readEnvFile();
    const vars = [];
    let pendingComment = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { pendingComment = null; continue; }
      if (trimmed.startsWith('#')) {
        const text = trimmed.replace(/^#+\s*/, '');
        if (text && !text.includes('=') && text.length < 120) pendingComment = text;
        else pendingComment = null;
        continue;
      }
      if (!trimmed.includes('=')) continue;
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const rawValue = trimmed.slice(idx + 1).trim();
      vars.push({
        key,
        value: ENV_SECRET_KEYS.has(key) ? '••••••••' : rawValue,
        rawValue,
        isSecret: ENV_SECRET_KEYS.has(key),
        isLocked: ENV_LOCKED_KEYS.has(key),
        isReadonly: ENV_READONLY_KEYS.has(key),
        impact: envVarImpact(key),
        description: pendingComment || '',
      });
      pendingComment = null;
    }

    res.json({ vars });
  });

  app.post('/api/env', (req, res) => {
    const { vars = {} } = req.body || {};
    const locked = Object.keys(vars).filter((k) => ENV_LOCKED_KEYS.has(k));
    if (locked.length) {
      return res.status(400).json({ error: `Cannot modify locked variables: ${locked.join(', ')}` });
    }

    const lines = readEnvFile();
    const updatedKeys = new Set();
    const result = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
        result.push(lines[i]);
        continue;
      }
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      if (key in vars) {
        const newValue = String(vars[key]).trim();
        const comment = lines[i].match(/#\s*(.+)$/);
        const suffix = comment ? `  # ${comment[1]}` : '';
        result.push(`${key}=${newValue}${suffix}`);
        updatedKeys.add(key);
      } else {
        result.push(lines[i]);
      }
    }

    for (const [key, value] of Object.entries(vars)) {
      if (!updatedKeys.has(key)) {
        result.push(`${key}=${String(value).trim()}`);
      }
    }

    writeEnvFile(result);

    const impacts = new Set();
    for (const key of Object.keys(vars)) {
      const impact = envVarImpact(key);
      if (impact !== 'locked' && impact !== 'readonly') impacts.add(impact);
    }

    res.json({ ok: true, updated: Object.keys(vars), impacts: [...impacts] });
  });

  app.post('/api/env/restart', async (req, res) => {
    // Logged loudly: this tears down every open terminal WebSocket and orphans
    // every tmux attach client, so an unexplained call needs to be attributable.
    console.warn(`[env/restart] CALLED by ${req.socket.remoteAddress} ua=${(req.headers['user-agent'] || '?').slice(0, 60)}`);
    res.json({ ok: true, message: 'Webui restarting in 1s…' });
    setTimeout(async () => {
      console.warn('[env/restart] executing docker restart paddock (t=1)');
      try {
        const c = await dockerClient.getContainer('paddock');
        await c.restart({ t: 1 });
      } catch (e) {
        console.error('Env restart failed:', e.message);
      }
    }, 500);
  });

  app.post('/api/env/recreate', async (req, res) => {
    // Same as /api/env/restart — an unexplained recreate is just as destructive.
    console.warn(`[env/recreate] CALLED by ${req.socket.remoteAddress} ua=${(req.headers['user-agent'] || '?').slice(0, 60)}`);
    res.json({ ok: true, message: 'Webui recreating in 1s…' });
    setTimeout(async () => {
      console.warn('[env/recreate] executing docker compose up -d --force-recreate webui');
      try {
        await runCmd('docker', ['compose', '-f', '/workspace/docker-compose.yml', 'up', '-d', '--force-recreate', 'webui'], { timeout: 120000 });
      } catch (e) {
        console.error('Env recreate failed, falling back to restart:', e.message);
        try {
          const c = await dockerClient.getContainer('paddock');
          await c.restart({ t: 1 });
        } catch {}
      }
    }, 500);
  });

  // ─── Agent type registry (drivers) ─────────────────────────────

  /** All known agent types — feeds the CreateAgent select and anything that
   *  needs a per-type list. Includes each type's setup steps so the create
   *  console can show the real command instead of a hardcoded one. */
  app.get('/api/agent-types', (req, res) => {
    res.json({ types: drivers.listDrivers() });
  });

  /** Command groups for one agent type — the "buttons" on the Commands tab
   *  live in the driver, not in the frontend bundle. tuiCommand is the command
   *  that launches the agent's interactive TUI (openclaw / opencode / …). Also
   *  serves the Paddock MCP connect/disconnect block (plan 35b). */
  app.get('/api/agent-types/:type/commands', (req, res) => {
    // Validate BEFORE resolving, and answer 404. This route takes the type
    // straight from the URL, and while getDriver used to fall back to openclaw a
    // typo here answered 200 with another agent's commands, MCP connect block and
    // tui command — measured live: `/api/agent-types/opencodee/commands` reported
    // `type: "openclaw"` and 4 commands. A not-found and a wrong-but-complete
    // answer look nothing alike to a caller, so this must be a refusal.
    if (!drivers.hasDriver(req.params.type)) {
      return res.status(404).json({
        error: `Unknown agent type '${req.params.type}'`,
        known: drivers.listDrivers().map((d) => d.type),
      });
    }
    const driver = drivers.getDriver(req.params.type);
    const paddockMcpUrl = getPaddockMcpUrl();
    res.json({
      type: driver.type,
      commands: driver.commands,
      tuiCommand: driver.tuiCommand || 'openclaw',
      mcp: drivers.getMcp(req.params.type, paddockMcpUrl),
    });
  });

  // ─── One-time migration: per-instance build files + image tags ─

  /** Run the build-file migration manually (also runs on boot). Idempotent. */
  app.get('/api/admin/migrate-builds', requireAdmin, async (req, res) => {
    try {
      const results = await vm.ensureInstanceBuilds({ onLog: (stream, text) => console.log(text) });
      res.json(results);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
