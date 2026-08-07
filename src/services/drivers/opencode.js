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
  configFile: 'opencode.json',
  installDockerBuildArg: 'INSTALL_DOCKER=1',
  tuiCommand: 'opencode',
  backupTypeMarker: '',

  /** No gateway/onboard flow — opencode config is created on first run. */
  setupSteps: [],

  /** Built-in web app the PAD can publish (Web tab). null/absent = no web
   *  app (e.g. codex, claude). `startCommand(opts)` builds the shell command
   *  from { containerPort, hostPort, password }; it is used both for the
   *  on-boot hook (start-web.sh) and the terminal "Start" button. */
  webApp: {
    label: 'OpenCode Web',
    docs: 'https://opencode.ai/docs/web/',
    containerPort: 8080,
    auth: {
      label: 'Server password',
      hint: 'Optional — protects the web UI with a password. The username is always "opencode".',
      target: 'env',
      envKey: 'OPENCODE_SERVER_PASSWORD',
    },
    startCommand({ password = '', containerPort }) {
      const pass = password ? `${this.auth.envKey}='${password}' ` : '';
      return `${pass}opencode web --hostname 0.0.0.0 --port ${containerPort}`;
    },
  },

  /** Command groups served to the Commands tab. */
  commands: [
    {
      title: 'Model', color: 'info',
      commands: [
        { cmd: 'opencode providers list', label: 'List providers', desc: 'Providers + saved credentials' },
        { cmd: 'opencode providers login', label: 'Login', desc: 'Log in to a provider (interactive)' },
        { cmd: 'opencode providers logout', label: 'Logout', desc: 'Log out a configured provider' },
        { cmd: 'opencode models', label: 'Available models', desc: 'List available models' },
      ],
    },
    {
      title: 'Session', color: 'info',
      commands: [
        { cmd: 'opencode session list', label: 'List sessions', desc: 'Recent sessions' },
        { cmd: 'opencode stats', label: 'Token usage', desc: 'Usage + cost statistics' },
        { cmd: 'opencode export', label: 'Export session', desc: 'Export session data as JSON' },
      ],
    },
    {
      title: 'MCP', color: 'success',
      commands: [
        { cmd: 'opencode mcp list', label: 'List servers', desc: 'Health check — MCP servers + status' },
        { cmd: 'opencode mcp add', label: 'Add server', desc: 'Add an MCP server (interactive)' },
        { cmd: 'opencode mcp auth', label: 'Auth server', desc: 'OAuth login for an MCP server' },
      ],
    },
    {
      title: 'Agent', color: 'brand',
      commands: [
        { cmd: 'opencode agent list', label: 'List agents', desc: 'Available agents' },
        { cmd: 'opencode agent create', label: 'Create agent', desc: 'Create a new agent (interactive)' },
      ],
    },
    {
      title: 'Other', color: 'slate',
      commands: [
        { cmd: 'opencode --version', label: 'Version', desc: 'opencode version' },
        { cmd: 'opencode debug info', label: 'Debug info', desc: 'opencode + system info' },
        { cmd: 'opencode debug config', label: 'Config', desc: 'Show resolved configuration' },
        { cmd: 'opencode upgrade', label: 'Upgrade', desc: 'Upgrade opencode to latest', confirm: true },
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
