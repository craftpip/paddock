const { execFile } = require('child_process');
const { imageFor } = require('../instance-image');

function runCmd(cmd, args, options = {}) {
  const { timeout = 120000 } = options;
  return new Promise((resolve, reject) => {
    execFile(cmd, args || [], { timeout }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout || '', stderr: stderr || '', code: 0 });
    });
  });
}

function parseVersion(output) {
  const m = /OpenClaw\s+([\w.+-]+)/i.exec(output || '');
  const v = m ? m[1] : ((output || '').trim());
  // Strip a packaging build suffix (label is "2026.7.1-1", CLI says "2026.7.1")
  return v ? v.replace(/-\d+$/, '') : '';
}

let _baseVersionCache = { key: '', ts: 0, value: '' };
const BASE_VERSION_CACHE_TTL = 5 * 60 * 1000;

const OPENCLAW = {
  type: 'openclaw',
  label: 'OpenClaw',
  templateDir: '../../src/vm-builds/openclaw',
  baseImage: 'ghcr.io/openclaw/openclaw:latest',
  dataDir: '/root/.openclaw',
  workspaceDir: '/root/.openclaw/workspace',
  /** Workspace-mount capability (plan 24): 'fixed' = the CLI requires its
   *  workspace at workspaceDir (container path input is read-only);
   *  'editable' = any valid container path works; 'none' = no custom mount. */
  workspaceCapability: 'fixed',
  configFile: 'openclaw.json',
  tuiCommand: 'openclaw',

  /** Steps run (docker exec) after the container comes up at create time. */
  setupSteps: [
    { cmd: 'openclaw', args: ['setup', '--baseline'] },
  ],

  /** Built-in web app the PAD can publish (Web tab) — the Gateway-served
   *  Control UI + WebChat on 18789. Unlike opencode/picoclaw/hermes this is
   *  NOT a separate server: start.sh already runs the gateway as the container
   *  main process, so "publishing" means patching gateway.bind → "lan" and
   *  gateway.auth with a token BEFORE the recreate (applyWebAuth in
   *  vm-manager.js) and verifying via the start-web.sh port probe. The auth
   *  target is 'openclaw.json' because the gateway reads the config on
   *  startup; auth is required (fails closed on non-loopback binds). The
   *  container port is fixed — the gateway can't be told to listen elsewhere. */
  webApp: {
    label: 'Gateway Dashboard + WebChat',
    docs: 'https://docs.openclaw.ai/web/control-ui',
    containerPort: 18789,
    containerPortEditable: false,
    // The gateway always serves the console (start.sh keeps it alive), so a
    // "start in terminal" button would paste a no-op — hide it.
    startable: false,
    auth: {
      label: 'Gateway token',
      hint: 'Required — the gateway refuses to listen outside loopback without auth. This token unlocks the Control UI. Paddock publishes over plain HTTP, so the Control UI device-identity check is disabled while published (token-only auth); the original setting is restored on unpublish.',
      target: 'openclaw.json',
      required: true,
      /** The Control UI accepts `#token=<gateway token>` in the URL fragment
       *  and hydrates auth from it (then strips it). Paddock appends the token
       *  so opening the console auto-authenticates — no manual paste. */
      urlToken: true,
    },
    startCommand() {
      // The gateway already serves the console (start.sh keeps it alive as the
      // main process); the hook only needs its port probe to verify, and a
      // no-op keeps the hook pipeline valid.
      return 'true';
    },
  },

  /** Command groups served to the Commands tab (`/api/agent-types/openclaw/commands`). */
  commands: [
    {
      title: 'Config', color: 'info',
      commands: [
        { cmd: 'openclaw config validate', label: 'Validate config', desc: 'Check config against schema' },
        { cmd: 'openclaw config file', label: 'Show config path', desc: 'Show active config path' },
      ],
    },
    {
      title: 'Security', color: 'danger',
      commands: [
        { cmd: 'openclaw security audit', label: 'Run audit', desc: 'Cold security audit' },
        { cmd: 'openclaw security audit --deep', label: 'Run deep audit', desc: 'Live probes' },
        { cmd: 'openclaw security audit --fix', label: 'Audit & fix', desc: 'Auto-fix issues', confirm: true },
        { cmd: 'openclaw doctor --lint', label: 'Run lint checks', desc: 'Read-only health checks & report findings' },
        { cmd: 'openclaw doctor --deep', label: 'Run deep scan', desc: 'Scan system services for extra gateway installs' },
      ],
    },
    {
      title: 'Doctor', color: 'warning',
      commands: [
        { cmd: 'openclaw doctor', label: 'Run doctor', desc: 'Health check — diagnose system status' },
        { cmd: 'openclaw doctor --fix', label: 'Auto-fix issues', desc: 'Auto-repair issues', confirm: true },
        { cmd: 'openclaw doctor --lint', label: 'Run lint checks', desc: 'Read-only CI-style checks' },
        { cmd: 'openclaw doctor --deep', label: 'Run deep scan', desc: 'Scan for extra gateways' },
        { cmd: 'openclaw doctor --state-sqlite compact', label: 'Compact SQLite', desc: 'Compact SQLite state (stop first)', confirm: true, danger: true },
      ],
    },
    {
      title: 'Diagnostics', color: 'accent',
      commands: [
        { cmd: 'openclaw status', label: 'Check agent status', desc: 'Health check — agent overview + gateway state' },
        { cmd: 'openclaw gateway status', label: 'Check gateway status', desc: 'Health check — bind, port + connectivity' },
      ],
    },
  ],

  /** Current version in a running container; falls back to reading it from the
   *  built image if the container is down. Returns '' when unknown. */
  async currentVersion(name) {
    try {
      const r = await runCmd('docker', ['exec', name, 'openclaw', '--version'], { timeout: 15000 });
      const v = parseVersion(r.stdout);
      if (v) return v;
    } catch {}
    try {
      const r = await runCmd('docker', ['run', '--rm', '--entrypoint', 'openclaw', imageFor(name), '--version'], { timeout: 60000 });
      return parseVersion(r.stdout);
    } catch {}
    return '';
  },

  /** Version available in the latest base image. Pulls the base tag (fast when
   *  unchanged) and reads its version label. Cached 5 min. Returns '' for
   *  drivers whose base image has no version label. */
  async availableVersion() {
    const base = OPENCLAW.baseImage;
    if (!base) return '';
    const now = Date.now();
    const key = 'base:' + base;
    if (_baseVersionCache.key === key && now - _baseVersionCache.ts < BASE_VERSION_CACHE_TTL) {
      return _baseVersionCache.value;
    }
    try { await runCmd('docker', ['pull', base], { timeout: 600000 }); } catch {}
    try {
      const r = await runCmd('docker', ['inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.version"}}', base], { timeout: 15000 });
      const v = parseVersion(r.stdout);
      _baseVersionCache = { key, ts: now, value: v };
      return v;
    } catch {
      _baseVersionCache = { key, ts: now, value: '' };
      return '';
    }
  },
};

module.exports = OPENCLAW;
