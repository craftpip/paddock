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
  // opencode prints a bare semver ("0.1.5") or "opencode 0.1.5"
  const m = /(\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)/.exec(output || '');
  return m ? m[1] : '';
}

const OPENCODE = {
  type: 'opencode',
  label: 'Opencode',
  templateDir: '../../src/vm-builds/opencode',
  baseImage: '',
  dataDir: '/root/.opencode',
  workspaceDir: '/root/.opencode/workspace',
  workspaceCapability: 'editable',
  configFile: 'opencode.json',
  tuiCommand: 'opencode',

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
        { cmd: 'opencode models --refresh', label: 'Refresh models', desc: 'Refresh the models cache from models.dev' },
      ],
    },
    {
      title: 'Session', color: 'info',
      commands: [
        { cmd: 'opencode session list', label: 'List sessions', desc: 'Recent sessions' },
        { cmd: 'opencode stats', label: 'Token usage', desc: 'Usage + cost statistics' },
        { cmd: 'opencode export', label: 'Export session', desc: 'Export session data as JSON' },
        { cmd: 'opencode session delete {sessionID}', label: 'Delete session', desc: 'Delete a session by ID', danger: true, fields: [
          { key: 'sessionID', label: 'Session ID', placeholder: 'e.g. abc123' },
        ]},
      ],
    },
    {
      title: 'MCP', color: 'success',
      commands: [
        { cmd: 'opencode mcp list', label: 'List servers', desc: 'Health check — MCP servers + status' },
        { cmd: 'opencode mcp add', label: 'Add server', desc: 'Add an MCP server (interactive)' },
        { cmd: 'opencode mcp auth', label: 'Auth server', desc: 'OAuth login for an MCP server' },
        { cmd: 'opencode mcp logout {name}', label: 'Logout OAuth', desc: 'Remove OAuth credentials for an MCP server', fields: [
          { key: 'name', label: 'Server name', placeholder: 'e.g. my-server', hint: 'Leave blank if unsure.' },
        ]},
        { cmd: 'opencode mcp debug {name}', label: 'Debug OAuth', desc: 'Debug the OAuth connection for an MCP server', fields: [
          { key: 'name', label: 'Server name', placeholder: 'e.g. my-server' },
        ]},
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
      title: 'Plugin', color: 'brand',
      commands: [
        { cmd: 'opencode plugin {module}', label: 'Install plugin', desc: 'Install an npm plugin module and update config', fields: [
          { key: 'module', label: 'npm module', placeholder: 'e.g. @opencode/plugin-…' },
        ]},
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

  /** Set B — the non-interactive LLM command catalog (plan 35a). Safe to run
   *  without a TTY through the MCP `exec` tool. */
  llmCommands: [
    {
      title: 'Run', commands: [
        { label: 'Run a task headlessly', cmd: 'opencode run --format json --dir <workspace> -- "<prompt>"', desc: 'Non-interactive run for scripting and task execution.' },
        { label: 'Run with model and agent', cmd: 'opencode run --format json --model <provider/model> --agent <name> -- "<prompt>"', desc: 'Pin the model and agent. Never select an agent with an @mention — headless runs silently fall through to the primary agent.', caveats: 'Add --auto to approve permissions not explicitly denied, or the run can hang waiting for approval with no TTY.' },
      ],
    },
    {
      title: 'Model', commands: [
        { label: 'List providers', cmd: 'opencode providers list', desc: 'Providers + saved credentials.' },
        { label: 'Logout provider', cmd: 'opencode providers logout', desc: 'Log out a configured provider.' },
        { label: 'Available models', cmd: 'opencode models', desc: 'List available models.' },
        { label: 'Refresh models', cmd: 'opencode models --refresh', desc: 'Refresh the models cache from models.dev.' },
      ],
    },
    {
      title: 'Session', commands: [
        { label: 'List sessions', cmd: 'opencode session list', desc: 'Recent sessions.' },
        { label: 'Token usage', cmd: 'opencode stats', desc: 'Usage + cost statistics.' },
        { label: 'Export session', cmd: 'opencode export', desc: 'Export session data as JSON.' },
        { label: 'Delete session', cmd: 'opencode session delete {sessionID}', desc: 'Delete a session by ID.', caveats: 'Destructive — confirm with the user first.' },
      ],
    },
    {
      title: 'MCP', commands: [
        { label: 'List servers', cmd: 'opencode mcp list', desc: 'MCP servers + status.' },
        { label: 'Logout OAuth', cmd: 'opencode mcp logout {name}', desc: 'Remove OAuth credentials for an MCP server.' },
        { label: 'Debug OAuth', cmd: 'opencode mcp debug {name}', desc: 'Debug the OAuth connection for an MCP server.' },
      ],
    },
    {
      title: 'Agent', commands: [
        { label: 'List agents', cmd: 'opencode agent list', desc: 'Available agents.' },
      ],
    },
    {
      title: 'Plugin', commands: [
        { label: 'Install plugin', cmd: 'opencode plugin {module}', desc: 'Install an npm plugin module and update config.' },
      ],
    },
    {
      title: 'Other', commands: [
        { label: 'Version', cmd: 'opencode --version', desc: 'opencode version.' },
        { label: 'Debug info', cmd: 'opencode debug info', desc: 'opencode + system info.' },
        { label: 'Config', cmd: 'opencode debug config', desc: 'Show resolved configuration.' },
        { label: 'Upgrade', cmd: 'opencode upgrade', desc: 'Upgrade opencode to latest.', caveats: 'Confirm with the user before running.' },
      ],
    },
  ],

  /** Interactive-only opencode commands — no non-interactive form. */
  notUsable: [
    { label: 'Login', cmd: 'opencode providers login', desc: 'Interactive provider login.' },
    { label: 'Add MCP server', cmd: 'opencode mcp add', desc: 'Interactive MCP add flow.' },
    { label: 'MCP OAuth login', cmd: 'opencode mcp auth', desc: 'Interactive OAuth flow.' },
    { label: 'Create agent', cmd: 'opencode agent create', desc: 'Interactive agent creation.' },
  ],

  /** Headless task capability (plan 48). Presence = the type can run queued
   *  tasks through the MCP task tools. The runner builds the machine wrapper
   *  (pidfile + PADDOCK_TASK_ID + `exec`), the driver supplies the inner CLI. */
  task: {
    supported: true,
    buildCommand(prompt, { workspaceDir, model, agent, autoApprove }) {
      const parts = ['opencode run', '--format json'];
      if (workspaceDir) parts.push('--dir', sq(workspaceDir));
      if (model && String(model).trim()) parts.push('--model', sq(String(model).trim()));
      if (agent && String(agent).trim()) parts.push('--agent', sq(String(agent).trim()));
      if (autoApprove) parts.push('--auto');
      parts.push('--', sq(prompt));
      return parts.join(' ');
    },
    /** `--format json` emits one raw event per line. Live shape (plan 47):
     *  `{"type":"text",…,"part":{"type":"text","text":"Done."}}` — the answer
     *  sits at `part.text`. Top-level `text` is kept as a fallback. Non-JSON
     *  output is kept whole. */
    extractSummary(raw) {
      const texts = [];
      for (const line of String(raw || '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let ev;
        try { ev = JSON.parse(trimmed); } catch { continue; }
        if (!ev || typeof ev !== 'object') continue;
        if (typeof ev.text === 'string') texts.push(ev.text);
        else if (ev.part && typeof ev.part === 'object' && typeof ev.part.text === 'string') {
          texts.push(ev.part.text);
        }
      }
      if (texts.length) return texts[texts.length - 1];
      return String(raw || '').trim();
    },
  },

  /** Paddock MCP server operations (plan 35b). opencode has no `mcp remove` in
   *  the installed build, so disconnect edits the global jsonc config
   *  (`/root/.opencode/config/opencode/opencode.jsonc`, confirmed live). Remote
   *  add does not probe at add time — no `--no-probe` equivalent needed. */
  mcp: {
    serverName: 'paddock',
    capabilities: { list: true, add: 'command', remove: 'configPatch', test: false },
    buildConnect({ url }) {
      const name = this.serverName;
      // opencode --header takes `KEY=VALUE` (equals form); remote-only.
      return bootstrap(
        `opencode mcp add ${name} --url ${sq(url)} --header "Authorization=Bearer $PADDOCK_MCP_TOKEN"`
      );
    },
    buildDisconnect() {
      // Remove the paddock entry by patching opencode's global jsonc config.
      // Comment stripping is string-aware: a naive /\/\// regex mangles
      // `"$schema": "https://..."` URLs. We re-serialize as plain JSON.
      const script = [
        "const fs=require('fs');const p='/root/.opencode/config/opencode/opencode.jsonc';",
        "if(!fs.existsSync(p))process.exit(0);",
        "function strip(s){let o='',q=!1,i=0;while(i<s.length){const c=s[i],n=s[i+1];if(q){if(c==='\\\\'){o+=c+n;i+=2;continue}o+=c;if(c==='\"')q=!1;i++;continue}if(c==='\"'){q=!0;o+=c;i++;continue}if(c==='/'&&n==='/'){while(i<s.length&&s[i]!=='\\n')i++;continue}if(c==='/'&&n==='*'){i+=2;while(i<s.length&&!(s[i]==='*'&&s[i+1]==='/'))i++;i+=2;continue}o+=c;i++}return o}",
        'const c=JSON.parse(strip(fs.readFileSync(p,"utf8")));',
        'if(c.mcp){delete c.mcp.paddock;if(Object.keys(c.mcp).length===0)delete c.mcp;}',
        'fs.writeFileSync(p,JSON.stringify(c,null,2));',
      ].join('\n');
      return `node -e ${sq(script)}`;
    },
    buildInspect() {
      return `opencode mcp list`;
    },
    buildTest() {
      return null;
    },
  },

  /** Current version in a running container; falls back to the built image. */
  async currentVersion(name) {
    try {
      const r = await runCmd('docker', ['exec', name, 'opencode', '--version'], { timeout: 15000 });
      const v = parseVersion(r.stdout || r.stderr);
      if (v) return v;
    } catch {}
    try {
      const r = await runCmd('docker', ['run', '--rm', '--entrypoint', 'opencode', imageFor(name), '--version'], { timeout: 60000 });
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
