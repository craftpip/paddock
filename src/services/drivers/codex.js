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

  /** No gateway/onboard flow — codex config is created on first run. */
  setupSteps: [],

  /** Command groups served to the Commands tab. All commands verified against
   *  codex-cli 0.147.0 in the test PAD. Note: codex has NO messaging channels
   *  and NO CLI skill management — skills are file-based (docs), so neither
   *  group has buttons here. */
  commands: [
    {
      title: 'Provider', color: 'info',
      commands: [
        { cmd: 'codex login', label: 'Login', desc: 'Log in to a provider (interactive)' },
        { cmd: 'codex login status', label: 'Login status', desc: 'Show current login status' },
        { cmd: 'codex logout', label: 'Logout', desc: 'Remove stored credentials', danger: true },
      ],
    },
    {
      title: 'MCP', color: 'success',
      commands: [
        { cmd: 'codex mcp list', label: 'List servers', desc: 'Configured MCP servers' },
        { cmd: 'codex mcp get {name}', label: 'Get server', desc: 'Show one server config', fields: [
          { key: 'name', label: 'Server name', placeholder: 'e.g. filesystem' },
        ]},
        { cmd: 'codex mcp add {name}', label: 'Add server', desc: 'Add an MCP server (interactive)', fields: [
          { key: 'name', label: 'Server name', placeholder: 'e.g. filesystem' },
        ]},
        { cmd: 'codex mcp remove {name}', label: 'Remove server', desc: 'Remove an MCP server', danger: true, fields: [
          { key: 'name', label: 'Server name', placeholder: 'e.g. filesystem' },
        ]},
        { cmd: 'codex mcp login {name}', label: 'OAuth login', desc: 'Log in to an OAuth MCP server', fields: [
          { key: 'name', label: 'Server name', placeholder: 'e.g. my-server' },
        ]},
        { cmd: 'codex mcp logout {name}', label: 'OAuth logout', desc: 'Clear OAuth credentials for a server', fields: [
          { key: 'name', label: 'Server name', placeholder: 'e.g. my-server' },
        ]},
      ],
    },
    {
      title: 'Session', color: 'accent',
      commands: [
        { cmd: 'codex resume --last', label: 'Continue last', desc: 'Resume the most recent session' },
        { cmd: 'codex review', label: 'Code review', desc: 'Run a non-interactive code review' },
      ],
    },
    {
      title: 'Plugin', color: 'brand',
      commands: [
        { cmd: 'codex plugin list', label: 'List plugins', desc: 'Plugins from configured marketplaces' },
        { cmd: 'codex plugin marketplace', label: 'Marketplaces', desc: 'Add/list/upgrade/remove plugin marketplaces (interactive)' },
        { cmd: 'codex plugin add {name}', label: 'Install plugin', desc: 'Install from a marketplace snapshot', fields: [
          { key: 'name', label: 'Plugin name', placeholder: 'e.g. openai/foo' },
        ]},
        { cmd: 'codex plugin remove {name}', label: 'Remove plugin', desc: 'Remove an installed plugin', danger: true, fields: [
          { key: 'name', label: 'Plugin name', placeholder: 'e.g. foo' },
        ]},
      ],
    },
    {
      title: 'Health', color: 'warning',
      commands: [
        { cmd: 'codex doctor', label: 'Doctor', desc: 'Diagnose install, config, auth and runtime health' },
      ],
    },
    {
      title: 'Other', color: 'slate',
      commands: [
        { cmd: 'codex --version', label: 'Version', desc: 'codex version' },
        { cmd: 'codex update', label: 'Update', desc: 'Update Codex to the latest version', confirm: true },
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
