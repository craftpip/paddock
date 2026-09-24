const { execFile } = require('child_process');
const { imageFor } = require('../instance-image');
const { sq, bootstrap } = require('./mcp-util');

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

  /** Set B — the non-interactive LLM command catalog (plan 35a). Safe to run
   *  without a TTY through the MCP `exec` tool. */
  llmCommands: [
    {
      title: 'Provider', commands: [
        { label: 'Login status', cmd: 'codex login status', desc: 'Show current login status.' },
        { label: 'Logout', cmd: 'codex logout', desc: 'Remove stored credentials.', caveats: 'Destructive — confirm with the user first.' },
      ],
    },
    {
      title: 'MCP', commands: [
        { label: 'List servers', cmd: 'codex mcp list', desc: 'Configured MCP servers.' },
        { label: 'Get server', cmd: 'codex mcp get {name}', desc: 'Show one server config.' },
        { label: 'Remove server', cmd: 'codex mcp remove {name}', desc: 'Remove an MCP server.', caveats: 'Destructive — confirm with the user first.' },
        { label: 'OAuth logout', cmd: 'codex mcp logout {name}', desc: 'Clear OAuth credentials for a server.' },
      ],
    },
    {
      title: 'Session', commands: [
        { label: 'Continue last', cmd: 'codex resume --last', desc: 'Resume the most recent session.' },
        { label: 'Code review', cmd: 'codex review', desc: 'Run a non-interactive code review.' },
      ],
    },
    {
      title: 'Plugin', commands: [
        { label: 'List plugins', cmd: 'codex plugin list', desc: 'Plugins from configured marketplaces.' },
        { label: 'Install plugin', cmd: 'codex plugin add {name}', desc: 'Install from a marketplace snapshot.' },
        { label: 'Remove plugin', cmd: 'codex plugin remove {name}', desc: 'Remove an installed plugin.', caveats: 'Destructive — confirm with the user first.' },
      ],
    },
    {
      title: 'Health', commands: [
        { label: 'Doctor', cmd: 'codex doctor', desc: 'Diagnose install, config, auth and runtime health.' },
      ],
    },
    {
      title: 'Other', commands: [
        { label: 'Version', cmd: 'codex --version', desc: 'codex version.' },
        { label: 'Update', cmd: 'codex update', desc: 'Update Codex to the latest version.', caveats: 'Confirm with the user before running.' },
        { label: 'Help', cmd: 'codex --help', desc: 'codex top-level help.' },
      ],
    },
  ],

  /** Interactive-only codex commands — no non-interactive form. */
  notUsable: [
    { label: 'Login', cmd: 'codex login', desc: 'Interactive provider login.' },
    { label: 'Add MCP server', cmd: 'codex mcp add {name}', desc: 'Interactive MCP add flow.' },
    { label: 'MCP OAuth login', cmd: 'codex mcp login {name}', desc: 'Interactive OAuth flow.' },
    { label: 'Marketplaces', cmd: 'codex plugin marketplace', desc: 'Interactive marketplace management.' },
  ],

  /** Headless task capability (plan 48). `codex exec --json` streams JSONL
   *  thread events to stdout; the final answer arrives as an
   *  `item.completed` event whose item is an agent message. `--skip-git-repo-check`
   *  is required: the default workspace is not a git repo and codex exec
   *  refuses to run there. `--sandbox danger-full-access` matches the runner's
   *  `autoApprove` contract (same trust level as the exec tool); drop it for a
   *  constrained read-only run. */
  task: {
    supported: true,
    buildCommand(prompt, { workspaceDir, model, autoApprove }) {
      const parts = ['codex exec', '--json', '--skip-git-repo-check'];
      if (workspaceDir) parts.push('-C', sq(workspaceDir));
      if (model && String(model).trim()) parts.push('-m', sq(String(model).trim()));
      if (autoApprove) parts.push('--sandbox', 'danger-full-access');
      parts.push('--', sq(prompt));
      return parts.join(' ');
    },
    /** JSONL event shape (live-captured 2026-09-24 on pad-test-codex):
     *  `{"type":"item.completed","item":{"id":"…","type":"agent_message",
     *  "text":"…"}}`. Older builds spelled the discriminator `item_type` with
     *  `assistant_message`. Accept both spellings; take the LAST agent message
     *  (earlier ones are interim status lines). Non-JSON output is kept whole. */
    extractSummary(raw) {
      const texts = [];
      for (const line of String(raw || '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let ev;
        try { ev = JSON.parse(trimmed); } catch { continue; }
        if (!ev || typeof ev !== 'object' || ev.type !== 'item.completed') continue;
        const item = ev.item;
        if (!item || typeof item !== 'object') continue;
        const kind = item.type || item.item_type;
        if (kind !== 'agent_message' && kind !== 'assistant_message') continue;
        if (typeof item.text === 'string' && item.text.trim()) texts.push(item.text);
      }
      if (texts.length) return texts[texts.length - 1];
      return String(raw || '').trim();
    },
  },

  /** Paddock MCP server operations (plan 35b). `codex mcp add` has NO inline
   *  header flag and NO non-interactive flag in this build (live-verified:
   *  `codex mcp add <name> --url <url> [--bearer-token-env-var <ENV>]`).
   *  `bearer_token_env_var` only attaches the token to POSTs, NOT the SSE GET
   *  stream (401 against servers that authenticate every request — ours does),
   *  so connect registers the server then patches config.toml to swap
   *  `bearer_token_env_var` for a static `http_headers` (sent on every request,
   *  per OpenAI codex docs). The literal token is stored in config.toml —
   *  equivalent to openclaw storing it in openclaw.json. Config at
   *  /root/.codex/config.toml; `[mcp_servers.<name>]` shape confirmed live.
   *  No python in the image → patch is a node script. */
  mcp: {
    serverName: 'paddock',
    capabilities: { list: true, add: 'command', remove: 'command', test: true },
    buildConnect({ url }) {
      const patch = [
        "const fs=require('fs');",
        "const p='/root/.codex/config.toml';",
        'let t=fs.readFileSync(p,"utf8");',
        'const tok=process.env.PADDOCK_MCP_TOKEN;',
        'const line="http_headers = { Authorization = \\"Bearer "+tok+"\\" }";',
        't=t.replace(/bearer_token_env_var\\s*=\\s*"[^"]*"/g,line);',
        'fs.writeFileSync(p,t);',
      ].join('\n');
      const inner = [
        `codex mcp add ${this.serverName} --url ${sq(url)} --bearer-token-env-var PADDOCK_MCP_TOKEN`,
        `node -e ${sq(patch)}`,
      ].join('\n');
      return bootstrap(inner);
    },
    buildDisconnect() {
      return `codex mcp remove ${this.serverName}`;
    },
    buildInspect() {
      return `codex mcp list`;
    },
    buildTest() {
      return `codex mcp get ${this.serverName}`;
    },
  },

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
