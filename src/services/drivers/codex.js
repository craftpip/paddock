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
  // codex --version prints something like "0.49.0" or "codex 0.49.0"
  const m = /(\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)/.exec(output || '');
  return m ? m[1] : '';
}

const CODEX = {
  type: 'codex',
  label: 'Codex',
  templateDir: '../../src/vm-builds/codex',
  baseImage: 'node:20-slim',
  dataDir: '/root/.codex',
  workspaceDir: '/root/.codex/workspace',
  workspaceCapability: 'editable',
  configFile: 'config.toml',
  configFormat: 'toml',
  tuiCommand: 'codex',
  backupTypeMarker: '',

  /** No gateway/onboard flow — codex config is created on first run. */
  setupSteps: [],

  /** Command groups served to the Commands tab. */
  commands: [
    {
      title: 'Session', color: 'info',
      commands: [
        { cmd: 'codex exec --help', label: 'Exec help', desc: 'codex exec usage (run codex non-interactively)' },
        { cmd: 'codex eval --help', label: 'Eval help', desc: 'codex eval usage' },
      ],
    },
    {
      title: 'Other', color: 'slate',
      commands: [
        { cmd: 'codex --version', label: 'Version', desc: 'codex version' },
        { cmd: 'codex --help', label: 'Help', desc: 'codex top-level help' },
      ],
    },
  ],

  /** Current version in a running container; falls back to the built image. */
  async currentVersion(name) {
    try {
      const r = await runCmd('docker', ['exec', name, 'codex', '--version'], { timeout: 15000 });
      const v = parseVersion(r.stdout || r.stderr);
      if (v) return v;
    } catch {}
    try {
      const r = await runCmd('docker', ['run', '--rm', '--entrypoint', 'codex', imageFor(name), '--version'], { timeout: 60000 });
      return parseVersion(r.stdout || r.stderr);
    } catch {}
    return '';
  },

  /** No base image tag → no update available. */
  async availableVersion() {
    return '';
  },
};

module.exports = CODEX;
