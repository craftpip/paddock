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

  /** Built-in web app the PAD can publish (Web tab) — the **launcher
   *  dashboard** (`picoclaw-launcher`, a separate background process, default
   *  18800). NOT the gateway (18790, `picoclaw gateway -E`), which only serves
   *  the pico chat WS at `/pico/ws` and returns 404 on root `/`. The launcher
   *  coexists fine with the gateway start.sh runs; it attaches and reports its
   *  own gatekeeping. It takes `-port <cport>` (editable), binds 0.0.0.0 with
   *  `-public`, and gates on a dashboard token that is random **per run** unless
   *  pinned via `PICOCLAW_LAUNCHER_TOKEN` (verified via `/api/auth/status` →
   *  `token_help.env_var_name`). Paddock pins it as the publish password, so
   *  the login gate (`/launcher-login`, `POST /api/auth/login {token}` →
   *  cookie `picoclaw_launcher_auth`) stays usable across recreates. */
  webApp: {
    label: 'Web Console (Launcher Dashboard)',
    docs: 'https://docs.picoclaw.io/',
    containerPort: 18800,
    containerPortEditable: true,
    auth: {
      label: 'Dashboard token',
      hint: 'Optional — pins the launcher dashboard token. Without it the token is random per run (recreated agents are locked out until the log is read).',
      target: 'env',
      envKey: 'PICOCLAW_LAUNCHER_TOKEN',
    },
    startCommand({ password = '', containerPort }) {
      const pass = password ? `${this.auth.envKey}='${password}' ` : '';
      return `${pass}picoclaw-launcher -console -no-browser -public -port ${containerPort}`;
    },
  },

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

  /** Set B — the non-interactive LLM command catalog (plan 35a). Safe to run
   *  without a TTY through the MCP `exec` tool. */
  llmCommands: [
    {
      title: 'Status', commands: [
        { label: 'Status', cmd: 'picoclaw status', desc: 'Version, config + workspace status.' },
        { label: 'Version', cmd: 'picoclaw version', desc: 'picoclaw version.' },
        { label: 'Default model', cmd: 'picoclaw model', desc: 'Show current default model.' },
      ],
    },
    {
      title: 'Auth', commands: [
        { label: 'Auth status', cmd: 'picoclaw auth status', desc: 'Current login state.' },
        { label: 'Available models', cmd: 'picoclaw auth models', desc: 'Models for configured providers.' },
        { label: 'Logout', cmd: 'picoclaw auth logout', desc: 'Remove stored credentials.' },
      ],
    },
    {
      title: 'Cron', commands: [
        { label: 'List jobs', cmd: 'picoclaw cron list', desc: 'All scheduled jobs.' },
        { label: 'Enable job', cmd: 'picoclaw cron enable {id}', desc: 'Enable a job by ID.' },
        { label: 'Disable job', cmd: 'picoclaw cron disable {id}', desc: 'Disable a job by ID.' },
        { label: 'Remove job', cmd: 'picoclaw cron remove {id}', desc: 'Remove a job by ID.', caveats: 'Destructive — confirm with the user first.' },
      ],
    },
    {
      title: 'Skills', commands: [
        { label: 'List installed', cmd: 'picoclaw skills list', desc: 'Installed skills.' },
        { label: 'Builtin skills', cmd: 'picoclaw skills list-builtin', desc: 'Available builtin skills.' },
        { label: 'Install builtin', cmd: 'picoclaw skills install-builtin', desc: 'Install all builtin skills to the workspace.' },
        { label: 'Search', cmd: 'picoclaw skills search', desc: 'Search skills.' },
        { label: 'Install', cmd: 'picoclaw skills install', desc: 'Install a skill from GitHub.' },
        { label: 'Show skill', cmd: 'picoclaw skills show {name}', desc: 'Show skill details.' },
        { label: 'Remove skill', cmd: 'picoclaw skills remove {name}', desc: 'Remove an installed skill.', caveats: 'Destructive — confirm with the user first.' },
      ],
    },
    {
      title: 'Other', commands: [
        { label: 'Check updates', cmd: 'picoclaw update', desc: 'Check for GitHub releases.' },
        { label: 'Migrate dry-run', cmd: 'picoclaw migrate --dry-run', desc: 'Preview openclaw → picoclaw migration.' },
      ],
    },
  ],

  /** Interactive-only picoclaw commands — no non-interactive form. */
  notUsable: [
    { label: 'Login', cmd: 'picoclaw auth login', desc: 'Interactive OAuth or token-paste login.' },
    { label: 'Connect WeChat', cmd: 'picoclaw auth weixin', desc: 'QR-code pairing — interactive.' },
    { label: 'Connect WeCom', cmd: 'picoclaw auth wecom', desc: 'QR-code scan — interactive.' },
    { label: 'Start gateway', cmd: 'picoclaw gateway', desc: 'Long-running messaging gateway — not an exec-able command.' },
    { label: 'Add job', cmd: 'picoclaw cron add', desc: 'Interactive job scheduling.' },
  ],

  /** Paddock MCP server operations (plan 35b). The installed picoclaw v0.2.5
   *  has NO `mcp` CLI group, so every operation is a parser-based patch of
   *  `config.json` (`tools.mcp.enabled` + `tools.mcp.servers.<name>`, shape
   *  verified live). Config lives at /root/.picoclaw/config.json. */
  mcp: {
    serverName: 'paddock',
    capabilities: { list: true, add: 'configPatch', remove: 'configPatch', test: false },
    buildConnect({ url }) {
      const script = [
        "const fs=require('fs');const p='/root/.picoclaw/config.json';",
        'let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){}',
        'c.tools=c.tools||{};c.tools.mcp=c.tools.mcp||{};',
        'c.tools.mcp.enabled=true;c.tools.mcp.servers=c.tools.mcp.servers||{};',
        `c.tools.mcp.servers.paddock={type:"http",url:${JSON.stringify(url)},headers:{Authorization:"Bearer "+process.env.PADDOCK_MCP_TOKEN}};`,
        'fs.writeFileSync(p,JSON.stringify(c,null,2));',
      ].join('\n');
      return bootstrap(`node -e ${sq(script)}`);
    },
    buildDisconnect() {
      const script = [
        "const fs=require('fs');const p='/root/.picoclaw/config.json';",
        'let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){}',
        'if(c.tools&&c.tools.mcp&&c.tools.mcp.servers){',
        '  delete c.tools.mcp.servers.paddock;',
        '  if(Object.keys(c.tools.mcp.servers).length===0){delete c.tools.mcp.servers;c.tools.mcp.enabled=false;}',
        '}',
        'fs.writeFileSync(p,JSON.stringify(c,null,2));',
      ].join('\n');
      return `node -e ${sq(script)}`;
    },
    buildInspect() {
      const script = "const c=require('/root/.picoclaw/config.json');console.log(JSON.stringify((c.tools&&c.tools.mcp)||{enabled:false,servers:{}},null,2));";
      return `node -e ${sq(script)}`;
    },
    buildTest() {
      return null;
    },
  },

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
