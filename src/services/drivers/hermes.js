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
  // `hermes version` prints `Hermes Agent v0.20.0 (2026.8.3)` (+ a small banner).
  const m = /(\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)/.exec(output || '');
  return m ? m[1] : '';
}

const HERMES = {
  type: 'hermes',
  label: 'Hermes',
  templateDir: '../../src/vm-builds/hermes',
  baseImage: 'nousresearch/hermes-agent:latest',
  dataDir: '/opt/data',
  workspaceDir: '/opt/data',
  configFile: 'config.yaml',
  configFormat: 'yaml',
  tuiCommand: 'hermes',
  backupTypeMarker: '',

  /** `hermes setup --non-interactive` bootstraps the data dir (SOUL.md,
   *  cron/hooks/memories/sessions/skills) without a TTY. Verified: runs
   *  clean and prints "Non-interactive mode" guidance instead of the wizard. */
  setupSteps: [
    { cmd: 'hermes', args: ['setup', '--non-interactive'] },
  ],

  /** Command groups from hermes' own CLI (`hermes --help`). Hermes is a full
   *  agent with gateway, cron, skills, memory, sessions and MCP — unlike
   *  opencode/picoclaw it has almost the whole surface area. */
  commands: [
    {
      title: 'Status', color: 'accent',
      commands: [
        { cmd: 'hermes status', label: 'Status', desc: 'Health check — environment, models, providers, gateway status' },
        { cmd: 'hermes version', label: 'Version', desc: 'Hermes version + install info' },
        { cmd: 'hermes doctor', label: 'Doctor', desc: 'Health check — diagnose config, MCP security, advisories' },
        { cmd: 'hermes config check', label: 'Config check', desc: 'Missing or outdated config' },
      ],
    },
    {
      title: 'Model', color: 'info',
      commands: [
        { cmd: 'hermes model', label: 'Default model', desc: 'Pick default model + provider (interactive)' },
        { cmd: 'hermes fallback', label: 'Fallbacks', desc: 'Manage fallback providers' },
        { cmd: 'hermes config get model.default', label: 'Current model', desc: 'Print the resolved default model' },
      ],
    },
    {
      title: 'Auth', color: 'brand',
      commands: [
        { cmd: 'hermes login', label: 'Login', desc: 'Log in to an inference provider' },
        { cmd: 'hermes logout', label: 'Logout', desc: 'Clear provider credentials' },
        { cmd: 'hermes auth', label: 'Auth status', desc: 'Health check — pooled provider credentials status' },
      ],
    },
    {
      title: 'Gateway', color: 'warning',
      commands: [
        { cmd: 'hermes gateway status', label: 'Gateway status', desc: 'Health check — is the messaging gateway running?' },
        { cmd: 'hermes gateway list', label: 'List profiles', desc: 'All profiles + gateway status' },
        { cmd: 'hermes gateway setup', label: 'Setup platforms', desc: 'Configure Telegram/Discord/WhatsApp (interactive)' },
        { cmd: 'hermes gateway restart', label: 'Restart gateway', desc: 'Restart the messaging gateway', confirm: true },
      ],
    },
    {
      title: 'Cron', color: 'success',
      commands: [
        { cmd: 'hermes cron list', label: 'List jobs', desc: 'All scheduled jobs' },
        { cmd: 'hermes cron create', label: 'Add job', desc: 'Schedule a new job (interactive)' },
      ],
    },
    {
      title: 'Skills', color: 'info',
      commands: [
        { cmd: 'hermes skills list', label: 'List installed', desc: 'Installed skills' },
        { cmd: 'hermes skills install', label: 'Install', desc: 'Install a skill from the hub' },
      ],
    },
    {
      title: 'Memory', color: 'brand',
      commands: [
        { cmd: 'hermes memory status', label: 'Memory status', desc: 'Health check — memory store state' },
        { cmd: 'hermes memory setup', label: 'Setup memory', desc: 'Configure the memory store' },
      ],
    },
    {
      title: 'Sessions', color: 'info',
      commands: [
        { cmd: 'hermes sessions list', label: 'List sessions', desc: 'Recent sessions' },
        { cmd: 'hermes --continue', label: 'Continue last', desc: 'Resume the most recent session' },
      ],
    },
    {
      title: 'Other', color: 'slate',
      commands: [
        { cmd: 'hermes mcp list', label: 'MCP servers', desc: 'Configured MCP servers' },
        { cmd: 'hermes backup -q', label: 'Quick backup', desc: 'Snapshot critical state (config, db, auth, cron)' },
      ],
    },
  ],

  /** Current version in a running container; falls back to the built image. */
  async currentVersion(name) {
    try {
      const r = await runCmd('docker', ['exec', name, 'hermes', 'version'], { timeout: 15000 });
      const v = parseVersion(r.stdout || r.stderr);
      if (v) return v;
    } catch {}
    try {
      const r = await runCmd('docker', ['run', '--rm', '--entrypoint', 'hermes', imageFor(name), 'version'], { timeout: 60000 });
      return parseVersion(r.stdout || r.stderr);
    } catch {}
    return '';
  },

  /** Base image is `:latest` with no version label → no update available. */
  async availableVersion() {
    return '';
  },
};

module.exports = HERMES;
