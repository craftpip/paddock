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
  // picoclaw prints `🦞 picoclaw 0.2.5 (git: bd56e10)` (plus an ASCII banner).
  const m = /(\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)/.exec(output || '');
  return m ? m[1] : '';
}

const PICOCLAW = {
  type: 'picoclaw',
  label: 'Picoclaw',
  templateDir: '../../src/vm-builds/picoclaw',
  baseImage: 'sipeed/picoclaw:v0.2.5-launcher',
  dataDir: '/root/.picoclaw',
  workspaceDir: '/root/.picoclaw/workspace',
  workspaceCapability: 'fixed',
  configFile: 'config.json',
  tuiCommand: 'picoclaw agent',

  /** picoclaw has no gateway daemon flow — `onboard` writes config.json +
   *  workspace non-interactively (verified: no TTY needed). */
  setupSteps: [
    { cmd: 'picoclaw', args: ['onboard'] },
  ],

  /** Command groups served to the Commands tab — from picoclaw's own CLI
   *  (`picoclaw --help` on v0.2.5). No backup/memory/doctor: picoclaw
   *  doesn't ship them. */
  commands: [
    {
      title: 'Status', color: 'accent',
      commands: [
        { cmd: 'picoclaw status', label: 'Status', desc: 'Health check — version, config + workspace status' },
        { cmd: 'picoclaw version', label: 'Version', desc: 'picoclaw version' },
        { cmd: 'picoclaw model', label: 'Default model', desc: 'Show current default model' },
      ],
    },
    {
      title: 'Auth', color: 'info',
      commands: [
        { cmd: 'picoclaw auth status', label: 'Auth status', desc: 'Health check — current login state' },
        { cmd: 'picoclaw auth models', label: 'Available models', desc: 'Models for configured providers' },
        { cmd: 'picoclaw auth login', label: 'Login', desc: 'Login via OAuth or paste token (interactive)' },
        { cmd: 'picoclaw auth logout', label: 'Logout', desc: 'Remove stored credentials' },
        { cmd: 'picoclaw auth weixin', label: 'Connect WeChat', desc: 'Pair a personal WeChat account via QR code (interactive)' },
        { cmd: 'picoclaw auth wecom', label: 'Connect WeCom', desc: 'Scan a WeCom QR code and configure the channel' },
      ],
    },
    {
      title: 'Channels', color: 'warning',
      commands: [
        { cmd: 'picoclaw gateway', label: 'Start gateway', desc: 'Run the picoclaw messaging gateway (long-running, Ctrl+C to stop)' },
      ],
    },
    {
      title: 'Cron', color: 'brand',
      commands: [
        { cmd: 'picoclaw cron list', label: 'List jobs', desc: 'All scheduled jobs' },
        { cmd: 'picoclaw cron add', label: 'Add job', desc: 'Schedule a new job (interactive)' },
        { cmd: 'picoclaw cron enable {id}', label: 'Enable job', desc: 'Enable a job by ID', fields: [
          { key: 'id', label: 'Job ID', placeholder: 'e.g. 1' },
        ]},
        { cmd: 'picoclaw cron disable {id}', label: 'Disable job', desc: 'Disable a job by ID', fields: [
          { key: 'id', label: 'Job ID', placeholder: 'e.g. 1' },
        ]},
        { cmd: 'picoclaw cron remove {id}', label: 'Remove job', desc: 'Remove a job by ID', danger: true, fields: [
          { key: 'id', label: 'Job ID', placeholder: 'e.g. 1' },
        ]},
      ],
    },
    {
      title: 'Skills', color: 'success',
      commands: [
        { cmd: 'picoclaw skills list', label: 'List installed', desc: 'Installed skills' },
        { cmd: 'picoclaw skills list-builtin', label: 'Builtin skills', desc: 'Available builtin skills' },
        { cmd: 'picoclaw skills install-builtin', label: 'Install builtin', desc: 'Install all builtin skills to the workspace' },
        { cmd: 'picoclaw skills search', label: 'Search', desc: 'Search skills' },
        { cmd: 'picoclaw skills install', label: 'Install', desc: 'Install a skill from GitHub' },
        { cmd: 'picoclaw skills show {name}', label: 'Show skill', desc: 'Show skill details', fields: [
          { key: 'name', label: 'Skill name', placeholder: 'e.g. weather' },
        ]},
        { cmd: 'picoclaw skills remove {name}', label: 'Remove skill', desc: 'Remove an installed skill', danger: true, fields: [
          { key: 'name', label: 'Skill name', placeholder: 'e.g. weather' },
        ]},
      ],
    },
    {
      title: 'Other', color: 'slate',
      commands: [
        { cmd: 'picoclaw update', label: 'Check updates', desc: 'Check for GitHub releases' },
        { cmd: 'picoclaw migrate --dry-run', label: 'Migrate dry-run', desc: 'Preview openclaw → picoclaw migration' },
      ],
    },
  ],

  /** Current version in a running container; falls back to the built image. */
  async currentVersion(name) {
    try {
      const r = await runCmd('docker', ['exec', name, 'picoclaw', 'version'], { timeout: 15000 });
      const v = parseVersion(r.stdout || r.stderr);
      if (v) return v;
    } catch {}
    try {
      const r = await runCmd('docker', ['run', '--rm', '--entrypoint', 'picoclaw', imageFor(name), 'version'], { timeout: 60000 });
      return parseVersion(r.stdout || r.stderr);
    } catch {}
    return '';
  },

  /** Base image is a pinned tag with no version label → no update available. */
  async availableVersion() {
    return '';
  },
};

module.exports = PICOCLAW;
