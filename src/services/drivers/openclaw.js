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
  backupTypeMarker: '_openclaw-backup-cli_',

  /** Steps run (docker exec) after the container comes up at create time. */
  setupSteps: [
    { cmd: 'openclaw', args: ['setup', '--baseline'] },
  ],

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
