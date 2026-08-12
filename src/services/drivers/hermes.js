const { execFile } = require('child_process');
const crypto = require('crypto');
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
  // `hermes version` prints `Hermes Agent v0.20.0 (2026.8.3)` (+ a small banner).
  const m = /(\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)/.exec(output || '');
  return m ? m[1] : '';
}

const HERMES = {
  type: 'hermes',
  label: 'Hermes',
  templateDir: '../../src/vm-builds/hermes',
  baseImage: 'nousresearch/hermes-agent:latest',
  dataDir: '/opt/data',
  workspaceDir: '/opt/data',
  workspaceCapability: 'none',
  configFile: 'config.yaml',
  configFormat: 'yaml',
  tuiCommand: 'hermes',

  /** `hermes setup --non-interactive` bootstraps the data dir (SOUL.md,
   *  cron/hooks/memories/sessions/skills) without a TTY. Verified: runs
   *  clean and prints "Non-interactive mode" guidance instead of the wizard. */
  setupSteps: [
    { cmd: 'hermes', args: ['setup', '--non-interactive'] },
  ],

  /** Built-in web app the PAD can publish (Web tab) — `hermes dashboard`, a
   *  separate process (the gateway does NOT serve it), default 9119. Web/pty
   *  extras are baked in the image (fastapi + uvicorn + prebuilt UI at
   *  /opt/hermes/hermes_cli/web_dist) — no Dockerfile change. It FAILS CLOSED
   *  on non-loopback binds: 0.0.0.0 without an auth provider refuses to bind
   *  ("Refusing to bind dashboard to 0.0.0.0 …"), so auth is REQUIRED here
   *  (unlike opencode/picoclaw where the password is optional). With
   *  `HERMES_DASHBOARD_BASIC_AUTH_USERNAME`/`_PASSWORD` set it binds 0.0.0.0,
   *  `auth_required: true`, and sensitive `/api/*` return 401 without a
   *  session. `_SECRET` HMAC-signs sessions — a stable value makes logins
   *  survive restarts, so Paddock derives it deterministically from the
   *  password (same password → same secret → hook stays stable). `envKey` is
   *  the PASSWORD var (that's what readWebAuth reads back); startCommand emits
   *  the whole env set. */
  webApp: {
    label: 'Web Dashboard',
    docs: 'https://hermes-agent.nousresearch.com/docs/',
    containerPort: 9119,
    containerPortEditable: true,
    auth: {
      label: 'Dashboard password',
      hint: 'Required — the dashboard refuses to bind outside loopback without basic auth. The username is always "admin"; a stable session secret is derived from this password so logins survive recreates.',
      target: 'env',
      envKey: 'HERMES_DASHBOARD_BASIC_AUTH_PASSWORD',
      required: true,
    },
    startCommand({ password = '', containerPort }) {
      const user = 'admin';
      const secret = crypto.createHash('sha256').update(`paddock-hermes:${password}`).digest('hex');
      return `HERMES_DASHBOARD_BASIC_AUTH_USERNAME='${user}' HERMES_DASHBOARD_BASIC_AUTH_PASSWORD='${password}' HERMES_DASHBOARD_BASIC_AUTH_SECRET='${secret}' hermes dashboard --host 0.0.0.0 --port ${containerPort} --no-open --skip-build`;
    },
  },

  /** Command groups from hermes' own CLI (`hermes --help`). Hermes is a full
   *  agent with gateway, cron, skills, memory, sessions and MCP — unlike
   *  opencode/picoclaw it has almost the whole surface area. */
  commands: [
    {
      title: 'Status', color: 'accent',
      commands: [
        { cmd: 'hermes status', label: 'Status', desc: 'Health check — environment, models, providers, gateway status' },
        { cmd: 'hermes version', label: 'Version', desc: 'Hermes version + install info' },
        { cmd: 'hermes doctor', label: 'Doctor', desc: 'Health check — diagnose config, MCP security, advisories' },
        { cmd: 'hermes config check', label: 'Config check', desc: 'Missing or outdated config' },
      ],
    },
    {
      title: 'Model', color: 'info',
      commands: [
        { cmd: 'hermes model', label: 'Default model', desc: 'Pick default model + provider (interactive)' },
        { cmd: 'hermes fallback', label: 'Fallbacks', desc: 'Manage fallback providers' },
        { cmd: 'hermes config get model.default', label: 'Current model', desc: 'Print the resolved default model' },
      ],
    },
    {
      title: 'Auth', color: 'brand',
      commands: [
        { cmd: 'hermes auth list', label: 'List credentials', desc: 'Pooled provider credentials' },
        { cmd: 'hermes auth add {provider}', label: 'Add credential', desc: 'Add a provider credential (key/OAuth prompt)', fields: [
          { key: 'provider', label: 'Provider id', placeholder: 'e.g. anthropic, openai-codex, openrouter', hint: 'Provider to add credentials for.' },
        ]},
        { cmd: 'hermes auth status {provider}', label: 'Auth status', desc: 'Credential status for a provider', fields: [
          { key: 'provider', label: 'Provider id', placeholder: 'e.g. openrouter' },
        ]},
        { cmd: 'hermes auth logout {provider}', label: 'Logout provider', desc: 'Clear stored auth state for a provider', danger: true, fields: [
          { key: 'provider', label: 'Provider id', placeholder: 'e.g. anthropic' },
        ]},
      ],
    },
    {
      title: 'Gateway', color: 'warning',
      commands: [
        { cmd: 'hermes gateway status', label: 'Gateway status', desc: 'Health check — is the messaging gateway running?' },
        { cmd: 'hermes gateway list', label: 'List profiles', desc: 'All profiles + gateway status' },
        { cmd: 'hermes gateway setup', label: 'Setup platforms', desc: 'Configure Telegram/Discord/WhatsApp (interactive)' },
        { cmd: 'hermes gateway restart', label: 'Restart gateway', desc: 'Restart the messaging gateway', confirm: true },
      ],
    },
    {
      title: 'Cron', color: 'success',
      commands: [
        { cmd: 'hermes cron list', label: 'List jobs', desc: 'All scheduled jobs' },
        { cmd: 'hermes cron create', label: 'Add job', desc: 'Schedule a new job (interactive)' },
        { cmd: 'hermes cron status', label: 'Scheduler status', desc: 'Is the cron scheduler running?' },
        { cmd: 'hermes cron pause {job_id}', label: 'Pause job', desc: 'Pause a scheduled job', fields: [
          { key: 'job_id', label: 'Job ID', placeholder: 'e.g. 3' },
        ]},
        { cmd: 'hermes cron resume {job_id}', label: 'Resume job', desc: 'Resume a paused job', fields: [
          { key: 'job_id', label: 'Job ID', placeholder: 'e.g. 3' },
        ]},
        { cmd: 'hermes cron remove {job_id}', label: 'Remove job', desc: 'Delete a scheduled job', danger: true, fields: [
          { key: 'job_id', label: 'Job ID', placeholder: 'e.g. 3' },
        ]},
      ],
    },
    {
      title: 'Skills', color: 'info',
      commands: [
        { cmd: 'hermes skills list', label: 'List installed', desc: 'Installed skills' },
        { cmd: 'hermes skills install', label: 'Install', desc: 'Install a skill from the hub (interactive)' },
        { cmd: 'hermes skills search {query}', label: 'Search', desc: 'Search skill registries', fields: [
          { key: 'query', label: 'Search query', placeholder: 'e.g. redis' },
        ]},
        { cmd: 'hermes skills check', label: 'Check updates', desc: 'Check installed hub skills for updates' },
        { cmd: 'hermes skills update', label: 'Update skills', desc: 'Update installed hub skills', confirm: true },
        { cmd: 'hermes skills uninstall {name}', label: 'Uninstall', desc: 'Remove a hub-installed skill', danger: true, fields: [
          { key: 'name', label: 'Skill name', placeholder: 'e.g. github' },
        ]},
      ],
    },
    {
      title: 'MCP', color: 'info',
      commands: [
        { cmd: 'hermes mcp list', label: 'List servers', desc: 'Configured MCP servers' },
        { cmd: 'hermes mcp catalog', label: 'Catalog', desc: 'Nous-approved MCP servers installable in one click' },
        { cmd: 'hermes mcp install {identifier}', label: 'Install from catalog', desc: 'One-click install a catalog MCP by name', fields: [
          { key: 'identifier', label: 'Catalog name', placeholder: 'e.g. n8n or official/<name>' },
        ]},
        { cmd: 'hermes mcp add {name}', label: 'Add server', desc: 'Connect a new MCP server (URL or stdio command)', fields: [
          { key: 'name', label: 'Server name', placeholder: 'e.g. filesystem', hint: 'Config key used for tools.' },
        ]},
        { cmd: 'hermes mcp remove {name}', label: 'Remove server', desc: 'Disconnect an MCP server', danger: true, fields: [
          { key: 'name', label: 'Server name', placeholder: 'e.g. filesystem' },
        ]},
        { cmd: 'hermes mcp test {name}', label: 'Test server', desc: 'Check a server connection', fields: [
          { key: 'name', label: 'Server name', placeholder: 'e.g. filesystem' },
        ]},
        { cmd: 'hermes mcp serve', label: 'Run as MCP server', desc: 'Expose Hermes to other agents via MCP (long-running)' },
      ],
    },
    {
      title: 'Memory', color: 'brand',
      commands: [
        { cmd: 'hermes memory status', label: 'Memory status', desc: 'Health check — memory store state' },
        { cmd: 'hermes memory setup', label: 'Setup memory', desc: 'Configure the memory store' },
      ],
    },
    {
      title: 'Sessions', color: 'info',
      commands: [
        { cmd: 'hermes sessions list', label: 'List sessions', desc: 'Recent sessions' },
        { cmd: 'hermes --continue', label: 'Continue last', desc: 'Resume the most recent session' },
        { cmd: 'hermes sessions export', label: 'Export', desc: 'Export sessions to JSONL/MD (interactive)' },
        { cmd: 'hermes sessions stats', label: 'Store stats', desc: 'Session store statistics' },
      ],
    },
    {
      title: 'Plugins', color: 'brand',
      commands: [
        { cmd: 'hermes plugins list', label: 'List plugins', desc: 'Installed plugins' },
        { cmd: 'hermes plugins install {identifier}', label: 'Install', desc: 'Install from a Git URL or owner/repo', fields: [
          { key: 'identifier', label: 'Git URL or owner/repo', placeholder: 'e.g. user/hermes-plugin-foo' },
        ]},
        { cmd: 'hermes plugins enable {name}', label: 'Enable', desc: 'Enable a disabled plugin', fields: [
          { key: 'name', label: 'Plugin name', placeholder: 'e.g. foo' },
        ]},
        { cmd: 'hermes plugins disable {name}', label: 'Disable', desc: 'Disable a plugin without removing it', fields: [
          { key: 'name', label: 'Plugin name', placeholder: 'e.g. foo' },
        ]},
      ],
    },
    {
      title: 'Other', color: 'slate',
      commands: [
        { cmd: 'hermes backup -q', label: 'Quick backup', desc: 'Snapshot critical state (config, db, auth, cron)' },
        { cmd: 'hermes logs -n 100', label: 'View logs', desc: 'Recent agent logs (last 100 lines)' },
      ],
    },
  ],

  /** Set B — the non-interactive LLM command catalog (plan 35a). Safe to run
   *  without a TTY through the MCP `exec` tool. */
  llmCommands: [
    {
      title: 'Status', commands: [
        { label: 'Status', cmd: 'hermes status', desc: 'Environment, models, providers, gateway status.' },
        { label: 'Version', cmd: 'hermes version', desc: 'Hermes version + install info.' },
        { label: 'Doctor', cmd: 'hermes doctor', desc: 'Diagnose config, MCP security, advisories.' },
        { label: 'Config check', cmd: 'hermes config check', desc: 'Missing or outdated config.' },
      ],
    },
    {
      title: 'Model', commands: [
        { label: 'Current model', cmd: 'hermes config get model.default', desc: 'Print the resolved default model.' },
        { label: 'Fallbacks', cmd: 'hermes fallback', desc: 'Manage fallback providers.' },
      ],
    },
    {
      title: 'Auth', commands: [
        { label: 'List credentials', cmd: 'hermes auth list', desc: 'Pooled provider credentials.' },
        { label: 'Auth status', cmd: 'hermes auth status {provider}', desc: 'Credential status for a provider.' },
        { label: 'Logout provider', cmd: 'hermes auth logout {provider}', desc: 'Clear stored auth state for a provider.', caveats: 'Destructive — confirm with the user first.' },
      ],
    },
    {
      title: 'Gateway', commands: [
        { label: 'Gateway status', cmd: 'hermes gateway status', desc: 'Is the messaging gateway running?' },
        { label: 'List profiles', cmd: 'hermes gateway list', desc: 'All profiles + gateway status.' },
        { label: 'Restart gateway', cmd: 'hermes gateway restart', desc: 'Restart the messaging gateway.', caveats: 'Restarts a live service — confirm with the user first.' },
      ],
    },
    {
      title: 'Cron', commands: [
        { label: 'List jobs', cmd: 'hermes cron list', desc: 'All scheduled jobs.' },
        { label: 'Scheduler status', cmd: 'hermes cron status', desc: 'Is the cron scheduler running?' },
        { label: 'Pause job', cmd: 'hermes cron pause {job_id}', desc: 'Pause a scheduled job.' },
        { label: 'Resume job', cmd: 'hermes cron resume {job_id}', desc: 'Resume a paused job.' },
        { label: 'Remove job', cmd: 'hermes cron remove {job_id}', desc: 'Delete a scheduled job.', caveats: 'Destructive — confirm with the user first.' },
      ],
    },
    {
      title: 'Skills', commands: [
        { label: 'List installed', cmd: 'hermes skills list', desc: 'Installed skills.' },
        { label: 'Search', cmd: 'hermes skills search {query}', desc: 'Search skill registries.' },
        { label: 'Check updates', cmd: 'hermes skills check', desc: 'Check installed hub skills for updates.' },
        { label: 'Update skills', cmd: 'hermes skills update', desc: 'Update installed hub skills.', caveats: 'Mutates installed skills — confirm with the user first.' },
        { label: 'Uninstall', cmd: 'hermes skills uninstall {name}', desc: 'Remove a hub-installed skill.', caveats: 'Destructive — confirm with the user first.' },
      ],
    },
    {
      title: 'MCP', commands: [
        { label: 'List servers', cmd: 'hermes mcp list', desc: 'Configured MCP servers.' },
        { label: 'Catalog', cmd: 'hermes mcp catalog', desc: 'Nous-approved MCP servers installable in one click.' },
        { label: 'Install from catalog', cmd: 'hermes mcp install {identifier}', desc: 'One-click install a catalog MCP by name.' },
        { label: 'Add server', cmd: 'hermes mcp add {name}', desc: 'Connect a new MCP server (URL or stdio command).' },
        { label: 'Remove server', cmd: 'hermes mcp remove {name}', desc: 'Disconnect an MCP server.', caveats: 'Destructive — confirm with the user first.' },
        { label: 'Test server', cmd: 'hermes mcp test {name}', desc: 'Check a server connection.' },
      ],
    },
    {
      title: 'Memory', commands: [
        { label: 'Memory status', cmd: 'hermes memory status', desc: 'Memory store state.' },
        { label: 'Setup memory', cmd: 'hermes memory setup', desc: 'Configure the memory store.' },
      ],
    },
    {
      title: 'Sessions', commands: [
        { label: 'List sessions', cmd: 'hermes sessions list', desc: 'Recent sessions.' },
        { label: 'Continue last', cmd: 'hermes --continue', desc: 'Resume the most recent session.' },
        { label: 'Store stats', cmd: 'hermes sessions stats', desc: 'Session store statistics.' },
      ],
    },
    {
      title: 'Plugins', commands: [
        { label: 'List plugins', cmd: 'hermes plugins list', desc: 'Installed plugins.' },
        { label: 'Install', cmd: 'hermes plugins install {identifier}', desc: 'Install from a Git URL or owner/repo.' },
        { label: 'Enable', cmd: 'hermes plugins enable {name}', desc: 'Enable a disabled plugin.' },
        { label: 'Disable', cmd: 'hermes plugins disable {name}', desc: 'Disable a plugin without removing it.' },
      ],
    },
    {
      title: 'Other', commands: [
        { label: 'Quick backup', cmd: 'hermes backup -q', desc: 'Snapshot critical state (config, db, auth, cron).' },
        { label: 'View logs', cmd: 'hermes logs -n 100', desc: 'Recent agent logs (last 100 lines).' },
      ],
    },
  ],

  /** Interactive-only hermes commands — no non-interactive form. */
  notUsable: [
    { label: 'Pick default model', cmd: 'hermes model', desc: 'Interactive provider/model picker — read `hermes config get model.default` instead.' },
    { label: 'Add credential', cmd: 'hermes auth add {provider}', desc: 'Interactive key/OAuth prompt.' },
    { label: 'Setup platforms', cmd: 'hermes gateway setup', desc: 'Interactive channel setup wizard.' },
    { label: 'Add job', cmd: 'hermes cron create', desc: 'Interactive job creation.' },
    { label: 'Install skill', cmd: 'hermes skills install', desc: 'Interactive hub install flow.' },
    { label: 'Run as MCP server', cmd: 'hermes mcp serve', desc: 'Long-running server process — not an exec-able command.' },
    { label: 'Export sessions', cmd: 'hermes sessions export', desc: 'Interactive export flow.' },
  ],

  /** Paddock MCP server operations (plan 35b). `hermes mcp add` has no
   *  non-interactive header flag (it probes live and prompts), so connect
   *  patches config.yaml directly. Hermes' own schema: top-level
   *  `mcp_servers.<name> = {url, headers: {Authorization: "Bearer ${MCP_<NAME>_API_KEY}"}}`
   *  with the secret persisted in `$HERMES_HOME/.env` (live-verified in
   *  hermes_cli/mcp_config.py: `_env_key_for_server`). For 'paddock' the env
   *  key is MCP_PADDOCK_API_KEY and the header template is interpolated at
   *  connect time. Config lives at /opt/data/config.yaml (HERMES_HOME=/opt/data);
   *  pyyaml is present in the venv. */
  mcp: {
    serverName: 'paddock',
    capabilities: { list: true, add: 'configPatch', remove: 'configPatch', test: true },
    buildConnect({ url }) {
      const urlLiteral = JSON.stringify(url);
      const envKey = 'MCP_PADDOCK_API_KEY';
      const headerTmpl = `Bearer $${'{' + envKey + '}'}`;
      const script = [
        'import os,yaml',
        "p='/opt/data/config.yaml'",
        "c=yaml.safe_load(open(p)) if os.path.exists(p) else {}",
        `c.setdefault('mcp_servers',{})['paddock']={'url':${urlLiteral},'headers':{'Authorization':'${headerTmpl}'}};`,
        "yaml.safe_dump(c,open(p,'w'),default_flow_style=False,sort_keys=False)",
        "e='/opt/data/.env'",
        "lines=open(e).read().splitlines() if os.path.exists(e) else []",
        `lines=[l for l in lines if not l.startswith('${envKey}=')]`,
        `lines.append('${envKey}='+os.environ['PADDOCK_MCP_TOKEN'])`,
        "open(e,'w').write('\\n'.join(lines)+'\\n')",
      ].join('\n');
      return bootstrap(`python3 -c ${sq(script)}`);
    },
    buildDisconnect() {
      const envKey = 'MCP_PADDOCK_API_KEY';
      const script = [
        'import os,yaml',
        "p='/opt/data/config.yaml'",
        "c=yaml.safe_load(open(p)) if os.path.exists(p) else {}",
        "if c and 'mcp_servers' in c:",
        "  c['mcp_servers'].pop('paddock',None)",
        "  if not c['mcp_servers']: c.pop('mcp_servers',None)",
        "  yaml.safe_dump(c,open(p,'w'),default_flow_style=False,sort_keys=False)",
        "e='/opt/data/.env'",
        "if os.path.exists(e):",
        `  lines=[l for l in open(e).read().splitlines() if not l.startswith('${envKey}=')]`,
        "  open(e,'w').write('\\n'.join(lines)+('\\n' if lines else ''))",
      ].join('\n');
      return `python3 -c ${sq(script)}`;
    },
    buildInspect() {
      return `hermes mcp list`;
    },
    buildTest() {
      return `hermes mcp test ${this.serverName}`;
    },
  },

  /** Current version in a running container; falls back to the built image. */
  async currentVersion(name) {
    try {
      const r = await runCmd('docker', ['exec', name, 'hermes', 'version'], { timeout: 15000 });
      const v = parseVersion(r.stdout || r.stderr);
      if (v) return v;
    } catch {}
    try {
      const r = await runCmd('docker', ['run', '--rm', '--entrypoint', 'hermes', imageFor(name), 'version'], { timeout: 60000 });
      return parseVersion(r.stdout || r.stderr);
    } catch {}
    return '';
  },

  /** Base image is `:latest` with no version label → no update available. */
  async availableVersion() {
    return '';
  },
};

module.exports = HERMES;
