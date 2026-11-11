/**
 * One PAD's settings: its configuration, dev container, published web door,
 * ports and health.
 */
const fs = require('fs');
const path = require('path');
const registry = require('../services/agent-registry');
const vm = require('../services/vm-manager');
const drivers = require('../services/drivers');
const jobLog = require('../services/job-log');
const containerHealth = require('../services/container-health');
const logStore = require('../services/log-store');
const { writeFileOwned } = require('../services/ownership');

/** Register this area's routes on the app. `ctx` carries the helpers app.js owns. */
module.exports = function register(app, ctx) {
  const {
    safeVmName, readMeta, INSTANCES_DIR, runCmd,
  } = ctx;

  app.get('/api/agents/:name/settings', async (req, res) => {
    const name = safeVmName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Invalid agent name' });
    try {
      const meta = readMeta(name);
      if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });
      res.json(await vm.readSettings(name));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** The Settings "Dev Container" card state (plan 41 item 20): file path,
   *  state badge, and both sides of the diff preview (current file vs what
   *  Paddock would write now from the pad's effective config). */
  app.get('/api/agents/:name/devcontainer', async (req, res) => {
    const name = safeVmName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Invalid agent name' });
    try {
      const status = vm.devContainerStatus(name);
      if (!status) return res.status(404).json({ error: 'Agent not found' });
      res.json(status);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Write back the pad's 1:1 mapped fields into the workspace devcontainer.json
   *  in place (project-authored files keep every non-mapped field; generated
   *  files regenerate wholesale). No container change. */
  app.post('/api/agents/:name/devcontainer/sync', async (req, res) => {
    const name = safeVmName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Invalid agent name' });
    try {
      const meta = readMeta(name);
      if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });
      const agentType = meta.AGENT || 'openclaw';
      const wsMount = vm.readWorkspaceMount(name, agentType);
      if (!wsMount) return res.status(400).json({ error: 'This agent has no custom workspace to sync' });
      const filePath = await vm.syncDevContainer(name, agentType, wsMount);
      if (!filePath) return res.status(400).json({ error: 'Nothing to sync — the pad never adopted this devcontainer' });
      res.json(vm.devContainerStatus(name));
    } catch (e) {
      if (e.code === 'pad_not_running' || e.code === 'devcontainer_write_failed') {
        return res.status(400).json({ error: e.message, code: e.code });
      }
      res.status(500).json({ error: e.message });
    }
  });

  /** Rewrite (or create) the workspace devcontainer.json as the pad's full
   *  generated mirror (marked `x-paddock.generated`). No container change. */
  app.post('/api/agents/:name/devcontainer/regenerate', async (req, res) => {
    const name = safeVmName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Invalid agent name' });
    try {
      const meta = readMeta(name);
      if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });
      const filePath = await vm.regenerateDevContainer(name, meta.AGENT || 'openclaw');
      if (!filePath) return res.status(400).json({ error: 'This agent has no custom workspace to write to' });
      res.json(vm.devContainerStatus(name));
    } catch (e) {
      if (e.code === 'pad_not_running' || e.code === 'devcontainer_write_failed') {
        return res.status(400).json({ error: e.message, code: e.code });
      }
      res.status(500).json({ error: e.message });
    }
  });

  /** Lazy-loaded raw container info for the Settings → Container Info popup.
   *  Runs `docker inspect <name>` on demand (never on page load) and returns a
   *  summarized view + the (env-redacted) raw inspect object. Shared with the MCP
   *  `settings_get` surface via `vm.containerInfo`. */
  app.get('/api/agents/:name/container-info', async (req, res) => {
    const name = safeVmName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Invalid agent name' });
    try {
      res.json(await vm.containerInfo(name));
    } catch (e) {
      res.status(/not found/i.test(e.message) ? 404 : 500).json({ error: e.message });
    }
  });

  /** Version info for the Update confirm dialog: current vs available (latest
   *  base image). Lets the user judge whether an update actually exists before
   *  committing to a rebuild. */
  app.get('/api/agents/:name/update-info', async (req, res) => {
    const name = safeVmName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Invalid agent name' });
    try {
      const meta = readMeta(name);
      if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });
      // Lenient by design: a pad whose meta.env has no AGENT line has NO type
      // to look up, and three live pads are in that state. getDriverOr falls
      // back only for that case — an AGENT line naming a type that is not a
      // driver still throws, instead of being answered with openclaw's fields.
      const driver = drivers.getDriverOr(meta.AGENT);
      const current = (await driver.currentVersion(name)) || meta.OPENCLAW_VERSION || '';
      const available = await driver.availableVersion();
      const updateAvailable = !!(current && available && current !== available);
      res.json({ currentVersion: current, availableVersion: available, updateAvailable });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/agents/:name/settings', async (req, res) => {
    const name = safeVmName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Invalid agent name' });
    const body = { ...(req.body || {}), actorRole: req.session.role };
    try {
      // Shared validation + change detection (plan 30) — the same
      // `prepareAgentChanges` the MCP recreate tool uses. An invalid request
      // returns 400 immediately instead of starting an SSE job.
      const ctx = await vm.prepareAgentChanges(name, body);
      if (!ctx.changed) {
        return res.json({
          allowDocker: ctx.newAllow,
          network: ctx.newNetwork,
          sshPort: ctx.newSshPort,
          sshContainerPort: ctx.newSshCport,
          image: vm.imageFor(name),
          workspaceMount: ctx.oldMount,
          extraVolumes: ctx.newVols,
        });
      }

      // Persist the requested docker state in the instance build.env — the toggle
      // is self-describing: the next rebuild reads INSTALL_DOCKER from the
      // env-file, no ad-hoc --build-arg needed. Turning docker off writes
      // INSTALL_DOCKER=0 for the next rebuild (the CLI stays in the current image
      // until then); the socket mount is controlled immediately by the compose
      // regen inside applyAgentChanges.
      vm.setBuildEnv(name, { INSTALL_DOCKER: ctx.newAllow ? '1' : '0' });

      // Any change that needs a recreate runs as an SSE job (like Update) so the
      // frontend can stream the live command output in a popup console.
      const jobKey = 'update:' + name;
      const job = jobLog.getOrCreateJob(jobKey);
      const log = (stream, text) => jobLog.line(job, stream, text);
      const step = (stepName, state, cmd) => jobLog.setStep(job, stepName, state, cmd);

      res.status(202).json({ ok: true, job: jobKey, streaming: true, reason: ctx.reason });

      setImmediate(async () => {
        registry.setRestarting(name, true);
        try {
          await logStore.capture(name);
          // The consolidated flow (shared with MCP recreate): validate → web hook
          // → applySettings (regenerate compose) → validateInstanceCompose →
          // stop → rebuild (docker-CLI / custom SSH cport / pull) or recreate →
          // door reconcile → web re-exec + verify → restore stopped state, with
          // rollback on failure.
          await vm.applyAgentChanges(name, body, { onLog: log, onStep: step });
          registry.dockerPsList(true);
          registry.discoverAgents();
          try {
            registry.recordActivity(name, 'settings', 'update', 'ok', `Settings updated (${ctx.summary.join(', ')})`);
          } catch {}
          log('system', 'Done — container recreated');
          jobLog.finish(job, true);
        } catch (e) {
          console.error(`Settings change failed for ${name}:`, e.message);
          try {
            registry.recordActivity(name, 'settings', 'update', 'error', e.message);
          } catch {}
          jobLog.fail(job, e.message);
        } finally {
          registry.setRestarting(name, false);
        }
      });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message, ...(e.code && typeof e.code === "string" ? { code: e.code } : {}) });
    }
  });

  /** Effective network peer name of an agent — meta.NETWORK, falling back to the
   *  compose file (legacy agents predate the meta flag). Empty = default network. */
  function currentNetworkPeer(name) {
    const meta = readMeta(name);
    if (meta.NETWORK) return meta.NETWORK;
    try {
      const cf = path.join(INSTANCES_DIR, name, 'docker-compose.yml');
      const m = /network_mode:\s*container:(\S+)/.exec(fs.readFileSync(cf, 'utf8'));
      return m ? m[1] : '';
    } catch {
      return '';
    }
  }

  app.get('/api/agents/:name/web', async (req, res) => {
    const name = safeVmName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Invalid agent name' });
    try {
      const meta = readMeta(name);
      if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });
      const driver = drivers.getDriverOr(meta.AGENT); // see the note in update-info
      // Extra Docker ports (plan 28) are independent of the built-in web app and
      // always reported — even for agent types with no web app to publish.
      const extraPorts = vm.readExtraPorts(name);
      if (!driver.webApp) return res.json({ webApp: null, extraPorts, sshPort: meta.PORT || '', sshContainerPort: vm.readSshCport(name) });

      const webService = vm.readWebService(name);
      const active = !!webService;
      let password = '';
      if (active) {
        password = vm.readWebAuth(driver, name);
      }

      // The published port lives on the agent itself on the default network, but
      // on the socat door container when the agent routes through a network peer
      // (the agent can't publish ports in that mode).
      const netPeer = currentNetworkPeer(name);
      const portContainer = netPeer ? vm.doorName(name) : name;
      let actualPorts = [];
      try {
        const p = await runCmd('docker', ['inspect', portContainer, '--format', '{{json .NetworkSettings.Ports}}'], { timeout: 15000 });
        const ports = JSON.parse(p.stdout || '{}');
        actualPorts = Object.keys(ports).map((k) => {
          const pub = ports[k] && ports[k][0];
          return { container: k, host: pub ? pub.HostPort : null };
        });
      } catch {}

      res.json({
        webApp: {
          label: driver.webApp.label,
          docs: driver.webApp.docs || '',
          containerPort: driver.webApp.containerPort,
          // Fixed-port consoles (openclaw gateway 18789) can't be retargeted —
          // the Web tab renders the container port read-only and warns about
          // peer-mode collisions.
          containerPortEditable: driver.webApp.containerPortEditable !== false,
          startable: driver.webApp.startable !== false,
          auth: driver.webApp.auth
            ? {
                label: driver.webApp.auth.label,
                hint: driver.webApp.auth.hint || '',
                required: !!driver.webApp.auth.required,
              }
            : null,
        },
        active,
        networkMode: netPeer,
        webService: active ? webService : null,
        passwordConfigured: active && !!password,
        // Token for the tokenized console URL (#token=...) — only for drivers
        // whose web console accepts it (openclaw Control UI). Others get ''.
        authToken: active && driver.webApp.auth && driver.webApp.auth.urlToken ? password : '',
        // Shell command that starts the console in the docked terminal (Start
        // button). When published it uses the live binding; otherwise it honors
        // draft ?containerPort&password query params (defaults: driver port, no
        // password) so the user can try the console without a recreate.
        startCommand: active
          ? driver.webApp.startCommand({ password, containerPort: webService.containerPort })
          : driver.webApp.startCommand({
              password: typeof req.query.password === 'string' ? req.query.password : '',
              containerPort: parseInt(req.query.containerPort, 10) || driver.webApp.containerPort,
            }),
        // Peer-mode collision: peer-shared agents share the door's network, so a
        // fixed container port can't be bound twice. Reported when another agent
        // on the same peer already publishes this container port.
        collision: netPeer && driver.webApp.containerPortEditable === false
          ? vm.findWebCollision(name, netPeer, driver.webApp.containerPort)
          : null,
        actualPorts,
        extraPorts,
        sshPort: meta.PORT || '',
        sshContainerPort: vm.readSshCport(name),
        // Remembered form drafts (plan 39) — last-used ports survive a toggle-off
        // so the re-published form is pre-filled. Passwords are never returned.
        draft: vm.readDrafts(name),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/agents/:name/web', async (req, res) => {
    const name = safeVmName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Invalid agent name' });
    const { active, hostPort, containerPort, password } = req.body || {};
    try {
      const meta = readMeta(name);
      if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });
      const driver = drivers.getDriverOr(meta.AGENT); // see the note in update-info
      if (!driver.webApp) return res.status(400).json({ error: 'This agent type has no web app to publish' });

      const turningOn = !!active;
      // Shared flow (plan 30): the web POST maps onto the `web` option of the
      // consolidated applyAgentChanges — write web.json + boot hook, regenerate
      // the compose, recreate, reconcile the socat door, exec the start hook and
      // verify. Invalid bindings return 400 immediately.
      const body = { web: { active: turningOn } };
      if (turningOn) {
        body.web.hostPort = hostPort;
        if (containerPort) body.web.containerPort = containerPort;
        // Empty password = keep the saved one (plan 39): omit the key so
        // prepareAgentChanges falls back to the existing token/password instead
        // of clearing optional auth.
        if (typeof password === 'string' && password.trim()) body.web.password = password;
      }
      await vm.prepareAgentChanges(name, body);

      const jobKey = 'update:' + name;
      const job = jobLog.getOrCreateJob(jobKey);
      const log = (stream, text) => jobLog.line(job, stream, text);
      const step = (stepName, state, cmd) => jobLog.setStep(job, stepName, state, cmd);

      res.status(202).json({ ok: true, job: jobKey, streaming: true, action: turningOn ? 'activate' : 'deactivate' });

      setImmediate(async () => {
        registry.setRestarting(name, true);
        try {
          await logStore.capture(name);
          const result = await vm.applyAgentChanges(name, body, { onLog: log, onStep: step });
          registry.dockerPsList(true);
          registry.discoverAgents();
          const published = result.webService ? result.webService.hostPort : hostPort;
          try {
            registry.recordActivity(name, 'web', turningOn ? 'publish' : 'unpublish', 'ok',
              turningOn ? `Web app published on host port ${published}` : 'Web app unpublished');
          } catch {}
          log('system', turningOn ? `Done — web app live at http://10.69.1.164:${published}` : 'Done — web app removed');
          jobLog.finish(job, true);
        } catch (e) {
          console.error(`Web change failed for ${name}:`, e.message);
          try {
            registry.recordActivity(name, 'web', turningOn ? 'publish' : 'unpublish', 'error', e.message);
          } catch {}
          jobLog.fail(job, e.message);
        } finally {
          registry.setRestarting(name, false);
        }
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ─── Additional Docker ports (plan 28) ──────────────────────

  /** Full-replace the agent's declared extra ports (independent of the built-in
   *  web app). Same SSE-job shape as settings: validate → stop → applySettings
   *  (regenerates the compose, preserving web/workspace/volumes) → recreate.
   *  Never touches web.json. */
  app.post('/api/agents/:name/ports', async (req, res) => {
    const name = safeVmName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Invalid agent name' });
    const { extraPorts } = req.body || {};
    try {
      const meta = readMeta(name);
      if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });

      // Shared flow (plan 30): validate + full-replace the extra ports through
      // the consolidated change set (peer mode included — extra ports ride the
      // agent's socat door, never its own ports).
      const body = { extraPorts: extraPorts || [] };
      const ctx = await vm.prepareAgentChanges(name, body);
      if (!ctx.changed) return res.json({ extraPorts: ctx.newPorts });

      const jobKey = 'update:' + name;
      const job = jobLog.getOrCreateJob(jobKey);
      const log = (stream, text) => jobLog.line(job, stream, text);
      const step = (stepName, state, cmd) => jobLog.setStep(job, stepName, state, cmd);

      res.status(202).json({ ok: true, job: jobKey, streaming: true, action: 'ports' });

      setImmediate(async () => {
        registry.setRestarting(name, true);
        const portsChanged = ctx.newPorts.length
          ? `extraPorts=${ctx.newPorts.map((p) => `${p.host}→${p.container}`).join(', ')}`
          : 'extraPorts=none';
        try {
          await logStore.capture(name);
          await vm.applyAgentChanges(name, body, { onLog: log, onStep: step });
          registry.dockerPsList(true);
          registry.discoverAgents();
          try {
            registry.recordActivity(name, 'ports', 'update', 'ok', portsChanged);
          } catch {}
          log('system', 'Done — container recreated with the new ports');
          jobLog.finish(job, true);
        } catch (e) {
          console.error(`Ports change failed for ${name}:`, e.message);
          try {
            registry.recordActivity(name, 'ports', 'update', 'error', e.message);
          } catch {}
          jobLog.fail(job, e.message);
        } finally {
          registry.setRestarting(name, false);
        }
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ─── Container health checkup ──────────────────────────────

  /** Passive report (no job) — powers the health pill on the Settings tab. */
  app.get('/api/agents/:name/health', async (req, res) => {
    const name = safeVmName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Invalid agent name' });
    try {
      const report = await containerHealth.checkContainerHealth(name);
      res.json(report);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Run the checkup as a job so each check streams live to the popup. */
  app.post('/api/agents/:name/health-check', async (req, res) => {
    const name = safeVmName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Invalid agent name' });
    try {
      const meta = readMeta(name);
      if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });

      const jobKey = 'health:' + name;
      const job = jobLog.getOrCreateJob(jobKey);
      const onCheck = (c) => jobLog.check(job, c);

      res.status(202).json({ ok: true, job: jobKey, streaming: true });

      setImmediate(async () => {
        try {
          const report = await containerHealth.checkContainerHealth(name, onCheck);
          jobLog.finish(job, true, { status: report.status, counts: report.counts });
        } catch (e) {
          console.error(`Health check failed for ${name}:`, e.message);
          jobLog.fail(job, e.message);
        }
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** SSE stream for the health-check job (mirrors update-log). */
  app.get('/api/agents/:name/health-log', (req, res) => {
    const name = safeVmName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Invalid agent name' });
    const since = parseInt(req.headers['last-event-id'], 10) || Math.max(0, parseInt(req.query.since, 10) || 0);
    const job = jobLog.getJob('health:' + name);

    if (!job) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'Health check job not found (run a health check first)' })}\n\n`);
      res.end();
      return;
    }

    jobLog.subscribe(job, res, since);
  });

  app.get('/api/agents/:name/config', (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    try {
      res.json(vm.readAgentConfig(agent));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/agents/:name/config', (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const { config: configStr } = req.body;
    if (!configStr) return res.status(400).json({ error: 'config required' });
    try {
      const driver = drivers.getDriver(agent.agent_type);
      const configPath = path.join(agent.config_root, driver.configFile || 'openclaw.json');
      if ((driver.configFormat || 'json') !== 'json') {
        // YAML/text config: write verbatim, no JSON validation.
        writeFileOwned(configPath, configStr.endsWith('\n') ? configStr : configStr + '\n', { boundary: agent.config_root });
        return res.json({ ok: true });
      }
      const newConfig = JSON.parse(configStr);
      writeFileOwned(configPath, JSON.stringify(newConfig, null, 2) + '\n', { boundary: agent.config_root });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
};
