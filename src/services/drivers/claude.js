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
  // claude --version prints `2.1.197 (Claude Code)`.
  const m = /(\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)/.exec(output || '');
  return m ? m[1] : '';
}

const CLAUDE = {
  type: 'claude',
  label: 'Claude',
  templateDir: '../../src/vm-builds/claude',
  baseImage: 'node:20-slim',
  dataDir: '/root/.claude',
  workspaceDir: '/root/.claude/workspace',
  workspaceCapability: 'editable',
  configFile: 'settings.json',
  tuiCommand: 'claude',

  /** No gateway/onboard flow — claude config is created on first run. */
  setupSteps: [],

  /** Command groups from the installed claude CLI — verified live against
   *  claude 2.1.197 in `pad-test-claude`. No messaging channels (its
   *  "channels" are MCP-push, not chat) and no CLI skill management (skills
   *  are file-based `.claude/skills/`), so neither has buttons. */
  commands: [
    {
      title: 'Status', color: 'accent',
      commands: [
        { cmd: 'claude doctor', label: 'Doctor', desc: 'Health check — installation + settings diagnostics' },
        { cmd: 'claude auth status', label: 'Auth status', desc: 'Health check — is the session logged in?' },
        { cmd: 'claude --version', label: 'Version', desc: 'claude version' },
      ],
    },
    {
      title: 'Auth', color: 'info',
      commands: [
        { cmd: 'claude auth login', label: 'Login', desc: 'Sign in to your Anthropic account (interactive)' },
        { cmd: 'claude auth logout', label: 'Logout', desc: 'Log out from your Anthropic account' },
        { cmd: 'claude setup-token', label: 'Setup token', desc: 'Generate a long-lived OAuth token for CI/scripts' },
      ],
    },
    {
      title: 'Session', color: 'brand',
      commands: [
        { cmd: 'claude -c', label: 'Continue last', desc: 'Resume the most recent conversation in this directory' },
        { cmd: 'claude --bg {prompt}', label: 'Start background agent', desc: 'Start a session in the background (manage via "List background")', fields: [
          { key: 'prompt', label: 'Prompt', placeholder: 'e.g. review this repo and file a summary', hint: 'The task the background agent should start with.' },
        ]},
        { cmd: 'claude agents --json', label: 'List background', desc: 'Active background sessions on this machine' },
        { cmd: 'claude agents --all --json', label: 'All sessions', desc: 'Background sessions incl. completed ones' },
      ],
    },
    {
      title: 'MCP', color: 'success',
      commands: [
        { cmd: 'claude mcp list', label: 'List servers', desc: 'Health check — configured MCP servers' },
        { cmd: 'claude mcp add -t {transport} {name} {commandOrUrl}', label: 'Add server', desc: 'Add an MCP server (URL for http/sse, command for stdio)', fields: [
          { key: 'name', label: 'Server name', placeholder: 'e.g. sentry' },
          { key: 'commandOrUrl', label: 'Command or URL', placeholder: 'https://mcp.example.com/mcp  or  npx my-mcp-server' },
          { key: 'transport', label: 'Transport', type: 'select', defaultValue: 'stdio', options: [
            { value: 'stdio', label: 'stdio — local command' },
            { value: 'http', label: 'http — remote URL' },
            { value: 'sse', label: 'sse — remote URL' },
          ]},
        ]},
        { cmd: 'claude mcp get {name}', label: 'Get server', desc: 'Show details for one server', fields: [
          { key: 'name', label: 'Server name', placeholder: 'e.g. sentry' },
        ]},
        { cmd: 'claude mcp remove {name}', label: 'Remove server', desc: 'Remove an MCP server', danger: true, fields: [
          { key: 'name', label: 'Server name', placeholder: 'e.g. sentry' },
        ]},
        { cmd: 'claude mcp login {name}', label: 'Login to server', desc: 'OAuth flow for an MCP server', fields: [
          { key: 'name', label: 'Server name', placeholder: 'e.g. sentry' },
        ]},
        { cmd: 'claude mcp logout {name}', label: 'Logout from server', desc: 'Clear OAuth credentials for an MCP server', fields: [
          { key: 'name', label: 'Server name', placeholder: 'e.g. sentry' },
        ]},
      ],
    },
    {
      title: 'Plugin', color: 'brand',
      commands: [
        { cmd: 'claude plugin list', label: 'List plugins', desc: 'Installed plugins' },
        { cmd: 'claude plugin marketplace', label: 'Marketplaces', desc: 'Manage Claude Code marketplaces (interactive)' },
        { cmd: 'claude plugin install {plugin}', label: 'Install', desc: 'Install from a marketplace (use plugin@marketplace to pin)', fields: [
          { key: 'plugin', label: 'Plugin', placeholder: 'e.g. my-plugin' },
        ]},
        { cmd: 'claude plugin update {plugin}', label: 'Update', desc: 'Update a plugin (restart required to apply)', fields: [
          { key: 'plugin', label: 'Plugin', placeholder: 'e.g. my-plugin' },
        ]},
        { cmd: 'claude plugin uninstall {plugin}', label: 'Uninstall', desc: 'Remove an installed plugin', danger: true, fields: [
          { key: 'plugin', label: 'Plugin', placeholder: 'e.g. my-plugin' },
        ]},
      ],
    },
    {
      title: 'Other', color: 'slate',
      commands: [
        { cmd: 'claude update', label: 'Update', desc: 'Update claude to the latest version', confirm: true },
        { cmd: 'claude install stable', label: 'Install stable', desc: 'Reinstall the native binary on the stable channel' },
      ],
    },
  ],

  /** Set B — the non-interactive LLM command catalog (plan 35a). Safe to run
   *  without a TTY through the MCP `exec` tool. */
  llmCommands: [
    {
      title: 'Status', commands: [
        { label: 'Doctor', cmd: 'claude doctor', desc: 'Installation + settings diagnostics.' },
        { label: 'Auth status', cmd: 'claude auth status', desc: 'Is the session logged in?' },
        { label: 'Version', cmd: 'claude --version', desc: 'claude version.' },
      ],
    },
    {
      title: 'Auth', commands: [
        { label: 'Logout', cmd: 'claude auth logout', desc: 'Log out from your Anthropic account.' },
      ],
    },
    {
      title: 'Session', commands: [
        { label: 'Start background agent', cmd: 'claude --bg {prompt}', desc: 'Start a background session with a task prompt.' },
        { label: 'List background', cmd: 'claude agents --json', desc: 'Active background sessions.' },
        { label: 'All sessions', cmd: 'claude agents --all --json', desc: 'Background sessions incl. completed ones.' },
      ],
    },
    {
      title: 'MCP', commands: [
        { label: 'List servers', cmd: 'claude mcp list', desc: 'Configured MCP servers.' },
        { label: 'Add server', cmd: 'claude mcp add -t {transport} {name} {commandOrUrl}', desc: 'Add an MCP server — URL for http/sse, command for stdio (transport: stdio|http|sse).', caveats: 'Fully parameterized, non-interactive. Verify afterwards with `claude mcp list`.' },
        { label: 'Get server', cmd: 'claude mcp get {name}', desc: 'Show details for one server.' },
        { label: 'Remove server', cmd: 'claude mcp remove {name}', desc: 'Remove an MCP server.', caveats: 'Destructive — confirm with the user first.' },
        { label: 'Logout from server', cmd: 'claude mcp logout {name}', desc: 'Clear OAuth credentials for an MCP server.' },
      ],
    },
    {
      title: 'Plugin', commands: [
        { label: 'List plugins', cmd: 'claude plugin list', desc: 'Installed plugins.' },
        { label: 'Install', cmd: 'claude plugin install {plugin}', desc: 'Install from a marketplace (plugin@marketplace to pin).' },
        { label: 'Update', cmd: 'claude plugin update {plugin}', desc: 'Update a plugin (restart required to apply).' },
        { label: 'Uninstall', cmd: 'claude plugin uninstall {plugin}', desc: 'Remove an installed plugin.', caveats: 'Destructive — confirm with the user first.' },
      ],
    },
    {
      title: 'Other', commands: [
        { label: 'Update', cmd: 'claude update', desc: 'Update claude to the latest version.', caveats: 'Confirm with the user before running.' },
        { label: 'Install stable', cmd: 'claude install stable', desc: 'Reinstall the native binary on the stable channel.' },
      ],
    },
  ],

  /** Interactive-only claude commands — no non-interactive form. */
  notUsable: [
    { label: 'Login', cmd: 'claude auth login', desc: 'Interactive account sign-in.' },
    { label: 'Setup token', cmd: 'claude setup-token', desc: 'Generates a long-lived token via an interactive flow.' },
    { label: 'Continue last', cmd: 'claude -c', desc: 'Opens the interactive TUI — needs a TTY.' },
    { label: 'MCP OAuth login', cmd: 'claude mcp login {name}', desc: 'Interactive OAuth flow.' },
    { label: 'Marketplaces', cmd: 'claude plugin marketplace', desc: 'Interactive marketplace management.' },
  ],

  /** Current version in a running container; falls back to the built image. */
  async currentVersion(name) {
    try {
      const r = await runCmd('docker', ['exec', name, 'claude', '--version'], { timeout: 15000 });
      const v = parseVersion(r.stdout || r.stderr);
      if (v) return v;
    } catch {}
    try {
      const r = await runCmd('docker', ['run', '--rm', '--entrypoint', 'claude', imageFor(name), '--version'], { timeout: 60000 });
      return parseVersion(r.stdout || r.stderr);
    } catch {}
    return '';
  },

  /** No base image version label → no update available. */
  async availableVersion() {
    return '';
  },
};

module.exports = CLAUDE;
