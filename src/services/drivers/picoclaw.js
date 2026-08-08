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
      ],
    },
    {
      title: 'Cron', color: 'brand',
      commands: [
        { cmd: 'picoclaw cron list', label: 'List jobs', desc: 'All scheduled jobs' },
        { cmd: 'picoclaw cron add', label: 'Add job', desc: 'Schedule a new job (interactive)' },
        { cmd: 'picoclaw cron remove', label: 'Remove job', desc: 'Remove a job by ID' },
      ],
    },
    {
      title: 'Skills', color: 'success',
      commands: [
        { cmd: 'picoclaw skills list', label: 'List installed', desc: 'Installed skills' },
        { cmd: 'picoclaw skills list-builtin', label: 'Builtin skills', desc: 'Available builtin skills' },
        { cmd: 'picoclaw skills search', label: 'Search', desc: 'Search skills' },
        { cmd: 'picoclaw skills install', label: 'Install', desc: 'Install a skill from GitHub' },
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
