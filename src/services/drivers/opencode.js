const { execFile } = require('child_process');

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
  // opencode prints a bare semver ("0.1.5") or "opencode 0.1.5"
  const m = /(\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)/.exec(output || '');
  return m ? m[1] : '';
}

const OPENCODE = {
  type: 'opencode',
  label: 'Opencode',
  buildImage: 'paddock-vm-opencode:latest',
  buildRel: '../../src/vm-builds/opencode',
  baseImage: '',
  dataDir: '/root/.opencode',
  workspaceDir: '/root/.opencode/workspace',
  installDockerBuildArg: 'INSTALL_DOCKER=1',
  tuiCommand: 'opencode',
  backupTypeMarker: '',

  /** No gateway/onboard flow — opencode config is created on first run. */
  setupSteps: [],

  /** Command groups served to the Commands tab. */
  commands: [
    {
      title: 'Model', color: 'teal',
      commands: [
        { cmd: 'opencode models', label: 'List models', desc: 'Available model providers' },
        { cmd: 'opencode login', label: 'Login', desc: 'Authenticate a provider' },
      ],
    },
    {
      title: 'Other', color: 'slate',
      commands: [
        { cmd: 'opencode --version', label: 'Version', desc: 'opencode version' },
        { cmd: 'opencode doctor', label: 'Doctor', desc: 'Diagnose issues' },
      ],
    },
  ],

  /** Current version in a running container; falls back to the built image. */
  async currentVersion(name) {
    try {
      const r = await runCmd('docker', ['exec', name, 'opencode', '--version'], { timeout: 15000 });
      const v = parseVersion(r.stdout || r.stderr);
      if (v) return v;
    } catch {}
    try {
      const r = await runCmd('docker', ['run', '--rm', '--entrypoint', 'opencode', OPENCODE.buildImage, '--version'], { timeout: 60000 });
      return parseVersion(r.stdout || r.stderr);
    } catch {}
    return '';
  },

  /** No base image tag → no update available. */
  async availableVersion() {
    return '';
  },
};

module.exports = OPENCODE;
