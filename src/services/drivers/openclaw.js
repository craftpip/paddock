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
  const m = /OpenClaw\s+([\w.+-]+)/i.exec(output || '');
  const v = m ? m[1] : ((output || '').trim());
  // Strip a packaging build suffix (label is "2026.7.1-1", CLI says "2026.7.1")
  return v ? v.replace(/-\d+$/, '') : '';
}

let _baseVersionCache = { key: '', ts: 0, value: '' };
const BASE_VERSION_CACHE_TTL = 5 * 60 * 1000;

const OPENCLAW = {
  type: 'openclaw',
  label: 'OpenClaw',
  templateDir: '../../src/vm-builds/openclaw',
  baseImage: 'ghcr.io/openclaw/openclaw:latest',
  dataDir: '/root/.openclaw',
  workspaceDir: '/root/.openclaw/workspace',
  /** Workspace-mount capability (plan 24): 'fixed' = the CLI requires its
   *  workspace at workspaceDir (container path input is read-only);
   *  'editable' = any valid container path works; 'none' = no custom mount. */
  workspaceCapability: 'fixed',
  configFile: 'openclaw.json',
  tuiCommand: 'openclaw',

  /** Steps run (docker exec) after the container comes up at create time. */
  setupSteps: [
    { cmd: 'openclaw', args: ['setup', '--baseline'] },
  ],

  /** Built-in web app the PAD can publish (Web tab) — the Gateway-served
   *  Control UI + WebChat on 18789. Unlike opencode/picoclaw/hermes this is
   *  NOT a separate server: start.sh already runs the gateway as the container
   *  main process, so "publishing" means patching gateway.bind → "lan" and
   *  gateway.auth with a token BEFORE the recreate (applyWebAuth in
   *  vm-manager.js) and verifying via the start-web.sh port probe. The auth
   *  target is 'openclaw.json' because the gateway reads the config on
   *  startup; auth is required (fails closed on non-loopback binds). The
   *  container port is fixed — the gateway can't be told to listen elsewhere. */
  webApp: {
    label: 'Gateway Dashboard + WebChat',
    docs: 'https://docs.openclaw.ai/web/control-ui',
    containerPort: 18789,
    containerPortEditable: false,
    // The gateway always serves the console (start.sh keeps it alive), so a
    // "start in terminal" button would paste a no-op — hide it.
    startable: false,
    auth: {
      label: 'Gateway token',
      hint: 'Required — the gateway refuses to listen outside loopback without auth. This token unlocks the Control UI. Paddock publishes over plain HTTP, so the Control UI device-identity check is disabled while published (token-only auth); the original setting is restored on unpublish.',
      target: 'openclaw.json',
      required: true,
      /** The Control UI accepts `#token=<gateway token>` in the URL fragment
       *  and hydrates auth from it (then strips it). Paddock appends the token
       *  so opening the console auto-authenticates — no manual paste. */
      urlToken: true,
    },
    startCommand() {
      // The gateway already serves the console (start.sh keeps it alive as the
      // main process); the hook only needs its port probe to verify, and a
      // no-op keeps the hook pipeline valid.
      return 'true';
    },
  },

  /** Command groups served to the Commands tab (`/api/agent-types/openclaw/commands`). */
  commands: [
    {
      title: 'Config', color: 'info',
      commands: [
        { cmd: 'openclaw config validate', label: 'Validate config', desc: 'Check config against schema' },
        { cmd: 'openclaw config file', label: 'Show config path', desc: 'Show active config path' },
      ],
    },
    {
      title: 'Security', color: 'danger',
      commands: [
        { cmd: 'openclaw security audit', label: 'Run audit', desc: 'Cold security audit' },
        { cmd: 'openclaw security audit --deep', label: 'Run deep audit', desc: 'Live probes' },
        { cmd: 'openclaw security audit --fix', label: 'Audit & fix', desc: 'Auto-fix issues', confirm: true },
        { cmd: 'openclaw doctor --lint', label: 'Run lint checks', desc: 'Read-only health checks & report findings' },
        { cmd: 'openclaw doctor --deep', label: 'Run deep scan', desc: 'Scan system services for extra gateway installs' },
      ],
    },
    {
      title: 'Doctor', color: 'warning',
      commands: [
        { cmd: 'openclaw doctor', label: 'Run doctor', desc: 'Health check — diagnose system status' },
        { cmd: 'openclaw doctor --fix', label: 'Auto-fix issues', desc: 'Auto-repair issues', confirm: true },
        { cmd: 'openclaw doctor --lint', label: 'Run lint checks', desc: 'Read-only CI-style checks' },
        { cmd: 'openclaw doctor --deep', label: 'Run deep scan', desc: 'Scan for extra gateways' },
        { cmd: 'openclaw doctor --state-sqlite compact', label: 'Compact SQLite', desc: 'Compact SQLite state (stop first)', confirm: true, danger: true },
      ],
    },
    {
      title: 'Diagnostics', color: 'accent',
      commands: [
        { cmd: 'openclaw status', label: 'Check agent status', desc: 'Health check — agent overview + gateway state' },
        { cmd: 'openclaw gateway status', label: 'Check gateway status', desc: 'Health check — bind, port + connectivity' },
      ],
    },
  ],

  /** Set B — the non-interactive LLM command catalog (plan 35a). Each command
   *  is safe to run without a TTY through the MCP `exec` tool. `{key}`
   *  placeholders are filled by the LLM with shell-quoted values. Commands that
   *  read a secret from stdin set `credentialInput: 'stdin'` — the value goes
   *  through `exec.stdin`, never in the command text or a tool result.
   *  Interactive-only commands (no non-interactive form) live in `notUsable`. */
  llmCommands: [
    {
      title: 'Models', commands: [
        { label: 'Add provider (API key)', cmd: 'openclaw models auth paste-api-key --provider {provider}', desc: 'Add a provider auth profile from an API key pasted to stdin.', caveats: 'CAUTION: this subcommand REWRITES the whole openclaw.json with auth-only content. Back up the config first (read config_get, store it), then run the command with exec.stdin = the key, then merge the result back so the rest of the config survives. This is the only non-interactive way to add a provider key.', credentialInput: 'stdin' },
        { label: 'List added providers', cmd: 'openclaw models auth list', desc: 'List saved auth profiles / added providers.' },
        { label: 'Remove provider', cmd: 'openclaw gateway call models.authLogout --params \'{"provider":"{provider}"}\' --json', desc: 'Delete a provider\'s saved auth profiles (logout).', caveats: 'No undo — the credentials are gone unless re-added.' },
        { label: 'Check available models', cmd: 'openclaw models list', desc: 'Models you are logged in to.' },
        { label: 'Check model status', cmd: 'openclaw models status', desc: 'Health check — auth + model status overview.' },
        { label: 'Set default model', cmd: 'openclaw models set {model}', desc: 'Set the primary model used by this agent (format provider/model).', caveats: 'Cron jobs store the model at creation — when changing a model used by cron, also run `openclaw cron update {id} --model {model}` for each affected job.' },
      ],
    },
    {
      title: 'MCP', commands: [
        { label: 'List servers', cmd: 'openclaw mcp list', desc: 'List configured MCP servers.' },
        { label: 'Add server (HTTP/SSE)', cmd: 'openclaw mcp add {name} --no-probe --url {url} --transport {transport}', desc: 'Add a remote MCP server (transport = streamable-http or sse).', caveats: 'Always pass --no-probe — a live probe can hang without a TTY. Verify afterwards with `openclaw mcp probe {name}`.' },
        { label: 'Add server (stdio)', cmd: 'openclaw mcp add {name} --no-probe --command {command}', desc: 'Add a local MCP server started by a shell command.', caveats: 'Always pass --no-probe. Verify afterwards with `openclaw mcp probe {name}`.' },
        { label: 'Remove server', cmd: 'openclaw mcp unset {name}', desc: 'Remove a configured MCP server.' },
        { label: 'Reload servers', cmd: 'openclaw mcp reload', desc: 'Reload MCP server config without restarting.' },
        { label: 'Probe server', cmd: 'openclaw mcp probe {name}', desc: 'Test connectivity to a configured server (name optional — probes all).' },
        { label: 'List server tools', cmd: 'openclaw mcp tools {name}', desc: 'List the tools exposed by a server; supports --include/--exclude filters.' },
        { label: 'Check server health', cmd: 'openclaw mcp doctor', desc: 'Diagnose MCP server setup.' },
      ],
    },
    {
      title: 'Skills', commands: [
        { label: 'List installed skills', cmd: 'openclaw skills list', desc: 'Skills installed / visible to the agent.' },
        { label: 'Check skills', cmd: 'openclaw skills check', desc: 'Which skills are ready vs missing requirements.' },
        { label: 'Search skills', cmd: 'openclaw skills search {query}', desc: 'Search the ClawHub catalog.' },
        { label: 'Install skill', cmd: 'openclaw skills install {ref}', desc: 'Install a skill by @owner/slug or owner/repo@ref.' },
        { label: 'Update all skills', cmd: 'openclaw skills update --all', desc: 'Update every installed skill.' },
      ],
    },
    {
      title: 'Memory', commands: [
        { label: 'Memory status', cmd: 'openclaw memory status', desc: 'Index status + memory availability.' },
        { label: 'Deep status', cmd: 'openclaw memory status --deep', desc: 'Probe vector store, embedding provider, semantic search.' },
        { label: 'Index memory', cmd: 'openclaw memory index', desc: 'Incremental indexing for all agents.' },
        { label: 'Reindex (force)', cmd: 'openclaw memory index --force', desc: 'Full reindex — drops and rebuilds the vector store.', caveats: 'Destructive — confirm with the user before running.' },
        { label: 'Search memory', cmd: 'openclaw memory search {query}', desc: 'Semantic search of indexed memory.' },
        { label: 'Promote memories', cmd: 'openclaw memory promote --apply', desc: 'Rank short-term memories and append top entries to MEMORY.md.', caveats: 'Mutates MEMORY.md — confirm with the user first.' },
      ],
    },
    {
      title: 'Messaging', commands: [
        { label: 'List channels', cmd: 'openclaw channels list --all', desc: 'List configured + available channels.' },
        { label: 'Check channel status', cmd: 'openclaw channels status --probe', desc: 'Live transport + audit check per account.' },
        { label: 'Check channel capabilities', cmd: 'openclaw channels capabilities', desc: 'What each channel supports.' },
        { label: 'View channel logs', cmd: 'openclaw channels logs --lines 100', desc: 'Recent channel runtime logs.' },
        { label: 'View channel routing', cmd: 'openclaw agents bindings', desc: 'Which agent owns which channel.' },
      ],
    },
    {
      title: 'Config', commands: [
        { label: 'Validate config', cmd: 'openclaw config validate', desc: 'Check config against schema.' },
        { label: 'Show config path', cmd: 'openclaw config file', desc: 'Show the active config path.' },
      ],
    },
    {
      title: 'Security', commands: [
        { label: 'Run audit', cmd: 'openclaw security audit', desc: 'Cold security audit.' },
        { label: 'Run deep audit', cmd: 'openclaw security audit --deep', desc: 'Audit with live probes.' },
        { label: 'Run lint checks', cmd: 'openclaw doctor --lint', desc: 'Read-only health checks.' },
        { label: 'Run deep scan', cmd: 'openclaw doctor --deep', desc: 'Scan system services for extra gateway installs.' },
      ],
    },
    {
      title: 'Doctor', commands: [
        { label: 'Run doctor', cmd: 'openclaw doctor', desc: 'Health check — diagnose system status.' },
        { label: 'Run lint checks', cmd: 'openclaw doctor --lint', desc: 'Read-only CI-style checks.' },
        { label: 'Run deep scan', cmd: 'openclaw doctor --deep', desc: 'Scan for extra gateways.' },
        { label: 'Compact SQLite', cmd: 'openclaw doctor --state-sqlite compact', desc: 'Compact the SQLite state store.', caveats: 'Destructive-ish maintenance — stop the agent first and confirm with the user.' },
      ],
    },
    {
      title: 'Diagnostics', commands: [
        { label: 'Check agent status', cmd: 'openclaw status', desc: 'Agent overview + gateway state.' },
        { label: 'Check gateway status', cmd: 'openclaw gateway status', desc: 'Gateway bind, port + connectivity.' },
      ],
    },
  ],

  /** Interactive-only openclaw commands with no non-interactive form — the
   *  guidance tells the LLM to ask the human to run these in the terminal. */
  notUsable: [
    { label: 'Add provider (interactive)', cmd: 'openclaw configure --section model', desc: 'Interactive TUI (login, OAuth, device code) — use the non-interactive `models auth paste-api-key` instead.' },
    { label: 'Add/remove channel', cmd: 'openclaw configure --section channels', desc: 'Interactive — no clean non-interactive replacement.' },
    { label: 'Configure skills', cmd: 'openclaw configure --section skills', desc: 'Interactive.' },
    { label: 'OAuth/device login', cmd: 'openclaw models auth login', desc: 'Runs provider OAuth/device flows — needs a TTY.' },
    { label: 'Interactive auth helper', cmd: 'openclaw models auth add', desc: 'Interactive helper — use paste-api-key instead.' },
  ],

  /** Paddock MCP server operations (plan 35b). buildConnect returns a command
   *  that reads the Paddock API key at the terminal (`read -rsp`), so the key
   *  never lands in the pasted command, shell history, or frontend state.
   *  --no-probe: a live probe fires an authenticated round-trip the user may
   *  not expect; verify with `openclaw mcp probe` instead. */
  mcp: {
    serverName: 'paddock',
    capabilities: { list: true, add: 'command', remove: 'command', test: true },
    buildConnect({ url }) {
      const name = this.serverName;
      return bootstrap(
        `openclaw mcp add ${name} --url ${sq(url)} --transport streamable-http --header "Authorization=Bearer $PADDOCK_MCP_TOKEN" --no-probe`
      );
    },
    buildDisconnect() {
      // Live-verified gotcha: the first `unset` can occasionally no-op and not
      // remove the server — retry on failure so the second identical call
      // actually removes it.
      return `openclaw mcp unset ${this.serverName} || openclaw mcp unset ${this.serverName} || true`;
    },
    buildInspect() {
      return `openclaw mcp list`;
    },
    buildTest() {
      return `openclaw mcp probe ${this.serverName}`;
    },
  },

  /** Current version in a running container; falls back to reading it from the
   *  built image if the container is down. Returns '' when unknown. */
  async currentVersion(name) {
    try {
      const r = await runCmd('docker', ['exec', name, 'openclaw', '--version'], { timeout: 15000 });
      const v = parseVersion(r.stdout);
      if (v) return v;
    } catch {}
    try {
      const r = await runCmd('docker', ['run', '--rm', '--entrypoint', 'openclaw', imageFor(name), '--version'], { timeout: 60000 });
      return parseVersion(r.stdout);
    } catch {}
    return '';
  },

  /** Version available in the latest base image. Pulls the base tag (fast when
   *  unchanged) and reads its version label. Cached 5 min. Returns '' for
   *  drivers whose base image has no version label. */
  async availableVersion() {
    const base = OPENCLAW.baseImage;
    if (!base) return '';
    const now = Date.now();
    const key = 'base:' + base;
    if (_baseVersionCache.key === key && now - _baseVersionCache.ts < BASE_VERSION_CACHE_TTL) {
      return _baseVersionCache.value;
    }
    try { await runCmd('docker', ['pull', base], { timeout: 600000 }); } catch {}
    try {
      const r = await runCmd('docker', ['inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.version"}}', base], { timeout: 15000 });
      const v = parseVersion(r.stdout);
      _baseVersionCache = { key, ts: now, value: v };
      return v;
    } catch {
      _baseVersionCache = { key, ts: now, value: '' };
      return '';
    }
  },
};

module.exports = OPENCLAW;
