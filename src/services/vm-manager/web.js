/**
 * Publishing a PAD's web console: the service record, the start hook, auth and
 * port checks.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  readWebService, webHookPath, readWebAuth, buildWebHook, resolveWebRequest, webServicePath,
  writeWebStartHook, applyWebAuth, webPortReachable, hostPortInUse, readWebState, removeWebAuth,
  removeWebStartHook, driverConfigPath, applyWebServices, findWebCollision,
});

const fs = require('fs');
const path = require('path');
const { ensureOwned, USER_UID, USER_GID, writeFileOwned } = require('../ownership');
const {
  INSTANCES_DIR, readMeta, PREFIX_RE, getDriver, runCmd, WEB_USER_DROP_MARKER, getDriverOr,
  assertWebPassword,
} = require('./internal');
const { seedBuildDir } = require('./build-files');
const { writeInstanceCompose, readExtraPorts, readSshCport } = require('./compose');
const { currentNetworkPeer, getPeerNetworkName, doorName } = require('./doors-network');
const { readDrafts } = require('./settings');

// ─── Web publishing (published built-in web app) ─────────────

function webServicePath(name) {
  return path.join(INSTANCES_DIR, name, 'web.json');
}

/** Read the single web binding for an agent, or null when not published.
 *  Shape: { containerPort, hostPort } */
function readWebService(name) {
  const p = webServicePath(name);
  if (!fs.existsSync(p)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!d || !d.hostPort) return null;
    return { containerPort: d.containerPort || 8080, hostPort: String(d.hostPort) };
  } catch {
    return null;
  }
}

/** Peer-mode web collision: agents routing through a network peer share the
 *  door's network stack, so two of them can't bind the same container port.
 *  Returns the first OTHER agent routing through the same peer that already
 *  publishes the given container port ({ name, hostPort }), or null. Only
 *  meaningful for fixed-container-port apps (the Web tab shows a warning). */
function findWebCollision(name, peer, containerPort) {
  if (!peer || !containerPort || !fs.existsSync(INSTANCES_DIR)) return null;
  for (const entry of fs.readdirSync(INSTANCES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === name) continue;
    const other = readWebService(entry.name);
    if (other && other.containerPort === containerPort && currentNetworkPeer(entry.name) === peer) {
      return { name: entry.name, hostPort: other.hostPort };
    }
  }
  return null;
}

/** Set (webService truthy) or clear (null/undefined) the published web app.
 *  Persists the binding in web.json and regenerates the compose file (the
 *  machine-generated compose remains the source of truth for the ports block,
 *  which also carries the SSH port). When the agent routes through a network
 *  peer, the compose gains the socat door service on the peer's network. */
async function applyWebServices(name, webService) {
  const instDir = path.join(INSTANCES_DIR, name);
  const meta = readMeta(instDir);
  const agent = meta.AGENT || 'openclaw';
  const pw = meta.ROOT_PASSWORD || name.replace(PREFIX_RE, '');
  const port = meta.PORT || '';
  const allowDocker = meta.DOCKER === '1';
  const network = meta.NETWORK || '';

  seedBuildDir(name, agent, { installDocker: allowDocker });

  const p = webServicePath(name);
  if (webService) {
    fs.writeFileSync(p, JSON.stringify({
      containerPort: webService.containerPort,
      hostPort: webService.hostPort,
      authToken: webService.authToken || '',
    }, null, 2));
    ensureOwned(p);
  } else if (fs.existsSync(p)) {
    fs.rmSync(p);
  }

  let webPeerNetwork = '';
  if (network) {
    webPeerNetwork = await getPeerNetworkName(network);
  }

  writeInstanceCompose(name, agent, pw, port, { allowDocker, network, webService, webPeerNetwork });
  return { agent, webService: webService || null };
}

/** Host path of the per-instance web start hook. It lives inside the agent's
 *  data dir bind mount (instances/<name>/<agent>/), so the container sees it
 *  at <dataDir>/start-web.sh — start.sh sources it on boot when present. */
function webHookPath(name, agent) {
  return path.join(INSTANCES_DIR, name, agent, 'start-web.sh');
}

/** Write (or remove) the web start hook for an agent. The webui runs as root
 *  (plan 43), so it writes the hook directly — the old root-helper fallback is
 *  gone. */
async function writeWebStartHook(name, agent, content) {
  const p = webHookPath(name, agent);
  writeFileOwned(p, content, { boundary: path.dirname(p), mode: 0o755 });
}

async function removeWebStartHook(name, agent) {
  const p = webHookPath(name, agent);
  if (!fs.existsSync(p)) return;
  fs.rmSync(p);
}

/** Normalize + validate a `web` publish request for the CREATE path (shared by
 *  `validateAgentCreate` and `createVm`, which re-checks as its second line of
 *  defense). Returns the `webService` shape `writeInstanceCompose` wants, or
 *  null when no web app is being published. Throws a user-facing error.
 *
 *  Publishing at create time needs no image rebuild: the start-web hook lives in
 *  the agent's BIND-MOUNTED data dir and every image template already runs it
 *  when present, so the hook is just a file we write. `applyWebAuth`'s config
 *  patch is applied AFTER the driver setup steps (the config may not exist yet
 *  at this point), then the hook is exec'd — same order `applyAgentChanges`
 *  uses on a publish. */
async function resolveWebRequest(name, agent, web, { sshHostPort = '', extraPorts = null } = {}) {
  if (web === undefined || web === null) return null;
  const driver = getDriver(agent);
  if (!driver.webApp) throw new Error('This agent type has no web app to publish');
  if (!web.active) return null;
  const hPort = String(web.hostPort !== undefined && web.hostPort !== null ? web.hostPort : '').trim();
  if (!/^\d+$/.test(hPort) || +hPort < 1 || +hPort > 65535) {
    throw new Error('Host port must be a number between 1 and 65535');
  }
  // Fixed-port drivers (openclaw gateway 18789) always publish the driver's
  // declared container port.
  const cPort = web.containerPort !== undefined && web.containerPort !== null && driver.webApp.containerPortEditable !== false
    ? Number(web.containerPort)
    : (driver.webApp.containerPort || 8080);
  if (!Number.isInteger(cPort) || cPort < 1 || cPort > 65535) {
    throw new Error('Container port must be a number between 1 and 65535');
  }
  if (sshHostPort && String(sshHostPort) === hPort) {
    throw new Error(`Host port ${hPort} is already the SSH port of this agent`);
  }
  for (const p of (extraPorts || [])) {
    if (p && String(p.host) === hPort) {
      throw new Error(`Host port ${hPort} is already listed in extraPorts`);
    }
  }
  if (await hostPortInUse(hPort, name)) {
    throw new Error(`Host port ${hPort} is already in use by another agent`);
  }
  const password = web.password === undefined || web.password === null ? '' : String(web.password);
  assertWebPassword(password);
  // Required-auth drivers (openclaw — fails closed on non-loopback binds) have
  // no token to fall back on at create time, so publishing needs one.
  if (driver.webApp.auth && driver.webApp.auth.required && !password) {
    throw new Error('A gateway token is required to publish this web app (openclaw refuses to listen outside loopback without auth)');
  }
  return {
    containerPort: cPort,
    hostPort: hPort,
    password,
    authToken: driver.webApp.auth && driver.webApp.auth.urlToken ? password : '',
  };
}

/** True when the given host port is published by any OTHER agent — either a
 *  declared compose port (other instances) or a live docker published port. */
async function hostPortInUse(hostPort, excludeName) {
  const h = String(hostPort);
  if (fs.existsSync(INSTANCES_DIR)) {
    for (const entry of fs.readdirSync(INSTANCES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === excludeName) continue;
      const cf = path.join(INSTANCES_DIR, entry.name, 'docker-compose.yml');
      if (fs.existsSync(cf)) {
        for (const m of fs.readFileSync(cf, 'utf8').matchAll(/"(\d+):\d+(?:\/(?:tcp|udp))?"/g)) {
          if (m[1] === h) return true;
        }
      }
    }
  }
  try {
    const r = await runCmd('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}'], { timeout: 15000 });
    for (const line of r.stdout.split('\n')) {
      const [cn, ports] = line.split('\t');
      if (!ports || cn === excludeName) continue;
      if (new RegExp(`(^|[,:])${h}->`).test(ports)) return true;
    }
  } catch {}
  return false;
}

/** Single-quote a string for embedding inside `sh -lc '<cmd>'`. Every `'`
 *  becomes `'\''` — the standard POSIX escape — so a generated start command
 *  carrying quotes (the web password does) survives unchanged. */
function shSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Shell content of the per-instance web start hook (start-web.sh). The hook
 *  is written into the agent's data-dir bind mount and executed by start.sh on
 *  boot, so the published server survives recreates. Execute it with `bash`,
 *  not `source`: its early exit must not terminate start.sh. It is re-runnable:
 *  a port probe skips the launch when an instance is already listening.
 *
 *  Plan 89: in a user-mode PAD the published agent server must run as the pad
 *  user (PUID:PGID, HOME=/root). A root-run server creates root-owned state —
 *  `/root/.local/state/opencode/locks` (0755 root) and the `.lock` dirs inside
 *  it (0700 root) — and the pad user can then never `mkdir` a lock again:
 *  `opencode mcp list` and every MCP-carrying session die with
 *  `PermissionDenied: FileSystem.makeDirectory …/locks/<hash>.lock`. The gate
 *  is on `$USER_MODE` at RUN time, not at generation time, because the SAME
 *  hook is executed by three different callers (the boot `start.sh`, and the
 *  create/apply paths in `docker exec`) and only some of them see a user-mode
 *  env directly — but all of them inherit the container's own env, so the
 *  runtime gate is the one place the answer is always right. A root-mode PAD
 *  keeps the exact old line.
 *
 *  Only the SERVER drops. `tee` deliberately stays root: `/proc/1/fd/1` (pid
 *  1's stdout, which is what `docker logs` and the Logs tab read) is NOT
 *  openable by the pad user — measured, `echo x >> /proc/1/fd/1` as uid 1000 is
 *  `Permission denied` — so a pad-user `tee` would lose the server's console
 *  stream entirely. The hook re-`chown`s the two files it owns (pidfile, log)
 *  to the pad user so nothing it creates stays root-owned. */
function buildWebHook(driver, agent, webService, password) {
  const dataDir = driver.dataDir;
  const pidFile = `${dataDir}/web.pid`;
  const logFile = `${dataDir}/web.log`;
  assertWebPassword(password); // every publish path builds the hook here
  const startCmd = driver.webApp.startCommand({ password, containerPort: webService.containerPort });
  return `#!/bin/bash
# Paddock web publishing — start the published web server on boot.
# Re-runnable: skips when something is already listening on the port (a plain
# pidfile can go stale across container recreates since the data dir persists).
if ( exec 3<>/dev/tcp/127.0.0.1/${webService.containerPort} ) 2>/dev/null; then
  exec 3>&- 2>/dev/null
  exit 0
fi
# ${WEB_USER_DROP_MARKER}: run the agent server as the pad user when this is a
# user-mode PAD (runtime gate), so it can never write root-owned state.
pad_run() {
  if command -v setpriv >/dev/null 2>&1; then
    setpriv --reuid ${USER_UID} --regid ${USER_GID} --clear-groups -- sh -lc "$1"
  else
    su -s /bin/bash pad -c "$1"
  fi
}
if [ "$USER_MODE" = "user" ] && [ "$(id -u)" = "0" ]; then
  pad_run ${shSingleQuote(startCmd)} 2>&1 | tee -a ${logFile} >/proc/1/fd/1 &
  echo $! > "${pidFile}"
  chown ${USER_UID}:${USER_GID} "${pidFile}" "${logFile}" 2>/dev/null || true
else
  ${startCmd} 2>&1 | tee -a ${logFile} >/proc/1/fd/1 &
  echo $! > "${pidFile}"
fi
`;
}

/** Host path of the driver's config file (instances/<name>/<agent>/...), the
 *  same file the container sees at <dataDir>/<configFile> via the bind mount.
 *  Only meaningful for drivers that keep a real config file on disk. */
function driverConfigPath(name, driver) {
  return path.join(INSTANCES_DIR, name, driver.type, driver.configFile || 'openclaw.json');
}

/** Effective web-publish auth secret for an agent, read back the same way it
 *  was applied: an 'env'-target driver embeds the secret in the start-web.sh
 *  hook via startCommand (opencode/picoclaw/hermes); an 'openclaw.json'-target
 *  driver stores it in the config file's gateway.auth.token (openclaw). Returns
 *  '' when nothing is configured. */
function readWebAuth(driver, name) {
  const auth = driver.webApp && driver.webApp.auth;
  if (auth && auth.target === 'openclaw.json') {
    // Preferred source: the token persisted in web.json at publish time. The
    // agent container rewrites openclaw.json as root, which the webui (uid
    // 1000) often can't read back — web.json is webui-owned and stable.
    try {
      const w = JSON.parse(fs.readFileSync(webServicePath(name), 'utf8'));
      if (w && w.authToken) return String(w.authToken);
    } catch {}
    const configPath = driverConfigPath(name, driver);
    if (!fs.existsSync(configPath)) return '';
    try {
      const d = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return (d.gateway && d.gateway.auth && d.gateway.auth.token) || '';
    } catch {
      return '';
    }
  }
  const hookPath = webHookPath(name, driver.type);
  if (!fs.existsSync(hookPath)) return '';
  const content = fs.readFileSync(hookPath, 'utf8');
  const envKey = (auth && auth.envKey) || 'OPENCODE_SERVER_PASSWORD';
  // The password for an 'env'-target driver lives ONLY in this hook — the
  // `authToken` in web.json is for urlToken drivers (openclaw). Plan 89 nested
  // the whole start command inside a shell `pad_run '<cmd>'` wrapper, which
  // turns the plain `KEY='pw'` into `KEY='\''pw'\''`; a naive `KEY='([^']*)'`
  // then captures the escape backslash and a regeneration would DESTROY the
  // credential (measured: `uMVbmzi6ACgWKDTN` → `\`). Match the escaped form
  // first, fall back to the plain form for a hook written before plan 89.
  const escaped = new RegExp(`${envKey}='\\\\''([^']*)'\\\\''`);
  const plain = new RegExp(`${envKey}='([^']*)'`);
  const m = escaped.exec(content) || plain.exec(content);
  // A lone backslash is the escape artifact of an EMPTY password (never a real
  // generated token), so it must not be read back as one and re-emitted.
  return m && m[1] !== '\\' ? m[1] : '';
}

/** Path of the state file holding an openclaw gateway's pre-publish
 *  `bind` + `auth` (written by applyWebAuth, consumed by removeWebAuth). It
 *  lives next to the config inside the agent's data dir so the root patch
 *  helper (which sees only that bind) can read/write it; apply chowns it to
 *  node so the webui can read it directly. */
function webOpenclawStatePath(name, driver) {
  const configPath = driverConfigPath(name, driver);
  return path.join(path.dirname(configPath), 'web-openclaw.json');
}

/** Pre-publish openclaw gateway state, or null. Shape: { bind, auth,
 *  controlUi }. */
function readWebOpenclawState(name, driver) {
  const p = webOpenclawStatePath(name, driver);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Apply the web-publish auth before the container is recreated. Only
 *  'openclaw.json'-target drivers need this: the openclaw gateway reads
 *  gateway.bind / gateway.auth from the config on startup, so the config must
 *  be patched (bind → lan + auth token) before the recreate. 'env'-target
 *  drivers embed the secret in the start-web.sh hook and need nothing here.
 *  The pre-publish gateway bind + auth are saved to a state file so unpublish
 *  restores exactly those fields without reverting unrelated config edits.
 *  Idempotent. No-op when the driver needs no config patch. The webui runs as
 *  root (plan 43), so the config is read/written directly — no helper. */
async function applyWebAuth(name, driver, password, { preserveState = false } = {}) {
  const auth = driver.webApp && driver.webApp.auth;
  if (!auth || auth.target !== 'openclaw.json') return;
  const configPath = driverConfigPath(name, driver);
  if (!fs.existsSync(configPath)) return;
  let d;
  try {
    d = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot patch openclaw.json for web publish: ${e.message}`);
  }
  const gw = (d.gateway && typeof d.gateway === 'object') ? d.gateway : {};
  // Persist the pre-publish state only on the FIRST publish. Re-publishing an
  // already-published pad (password or host-port change) must NOT overwrite the
  // saved original with the current published form, or unpublish would restore
  // the published state instead of the pre-publish one.
  if (!preserveState) {
    const statePath = webOpenclawStatePath(name, driver);
    if (!fs.existsSync(statePath)) {
      fs.writeFileSync(statePath, JSON.stringify({
        bind: gw.bind || '',
        auth: gw.auth !== undefined ? gw.auth : null,
        controlUi: gw.controlUi !== undefined ? gw.controlUi : null,
      }, null, 2));
      ensureOwned(statePath);
    }
  }
  // Paddock publishes over plain HTTP; the Control UI requires a device
  // identity in a secure context otherwise, so disable that check (token-only
  // auth). Restored to the pre-publish value by removeWebAuth.
  d.gateway = { ...gw, bind: 'lan', auth: { mode: 'token', token: String(password || '') }, controlUi: { dangerouslyDisableDeviceAuth: true } };
  fs.writeFileSync(configPath, JSON.stringify(d, null, 2) + '\n');
  ensureOwned(configPath);
}

/** Undo a web-publish config patch: restore the saved pre-publish gateway
 *  `bind` + `auth` (preserving any unrelated config edits made while
 *  published) and drop the state file. No-op for drivers that need no patch or
 *  when nothing was patched. The webui runs as root (plan 43), so the config
 *  is restored directly. */
async function removeWebAuth(name, driver) {
  const auth = driver.webApp && driver.webApp.auth;
  if (!auth || auth.target !== 'openclaw.json') return;
  const saved = readWebOpenclawState(name, driver);
  if (!saved) return;
  const configPath = driverConfigPath(name, driver);
  if (!fs.existsSync(configPath)) {
    try { fs.rmSync(webOpenclawStatePath(name, driver)); } catch {}
    return;
  }
  try {
    const d = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const gw = (d.gateway && typeof d.gateway === 'object') ? { ...d.gateway } : {};
    if (saved.bind) gw.bind = saved.bind; else delete gw.bind;
    if (saved.auth) gw.auth = saved.auth; else delete gw.auth;
    if (saved.controlUi) gw.controlUi = saved.controlUi; else delete gw.controlUi;
    if (Object.keys(gw).length) d.gateway = gw; else delete d.gateway;
    fs.writeFileSync(configPath, JSON.stringify(d, null, 2) + '\n');
    ensureOwned(configPath);
    try { fs.rmSync(webOpenclawStatePath(name, driver)); } catch {}
  } catch (e) {
    // Unreadable for another reason — keep the state file so a later attempt
    // (or manual fix) can still restore the original bind/auth.
    console.error(`removeWebAuth could not restore openclaw.json for ${name}:`, e.message);
  }
}

/** Can the container reach its own published web port? Used to verify the web
 *  server actually came up after activation (bash /dev/tcp, no extra tools). */
async function webPortReachable(name, port) {
  try {
    const r = await runCmd('docker', ['exec', name, 'bash', '-lc', `exec 3<>/dev/tcp/127.0.0.1/${port} && echo UP || echo DOWN`], { timeout: 10000 });
    return (r.stdout || '').includes('UP');
  } catch {
    return false;
  }
}

/** Published-web state, shared by `GET /api/agents/:name/web`, `readSettings`
 *  (which embeds it) and the MCP `settings_get` tool.
 *
 *  `redact: true` (what the MCP tool passes) drops the two fields that carry the
 *  live web password: `authToken` (the bearer credential for a tokenized
 *  console URL) and `startCommand` (the driver's command with the password baked
 *  in). Both are legitimate for the operator's own dashboard — the Web tab needs
 *  `authToken` to build the `#token=…` link and `startCommand` for the Start
 *  button — so `GET /api/agents/:name/web` and the settings REST route are
 *  unchanged. `passwordConfigured` already answers "is there one". */
async function readWebState(name, { redact = false } = {}) {
  const meta = readMeta(path.join(INSTANCES_DIR, name));
  const agentType = meta.AGENT || 'openclaw';
  // Lenient ONLY for a pad with no AGENT line (no type to look up); a line
  // naming an unknown type throws rather than answering openclaw's fields.
  const driver = getDriverOr(meta.AGENT);
  const extraPorts = readExtraPorts(name);
  const sshPort = meta.PORT || '';
  const sshContainerPort = readSshCport(name);
  if (!driver.webApp) return { webApp: null, extraPorts, sshPort, sshContainerPort, draft: readDrafts(name) };
  const webService = readWebService(name);
  const active = !!webService;
  let password = '';
  if (active) password = readWebAuth(driver, name);
  const netPeer = currentNetworkPeer(name);
  const portContainer = netPeer ? doorName(name) : name;
  let actualPorts = [];
  try {
    const p = await runCmd('docker', ['inspect', portContainer, '--format', '{{json .NetworkSettings.Ports}}'], { timeout: 15000 });
    const ports = JSON.parse(p.stdout || '{}');
    actualPorts = Object.keys(ports).map((k) => {
      const pub = ports[k] && ports[k][0];
      return { container: k, host: pub ? pub.HostPort : null };
    });
  } catch {}
  return {
    webApp: {
      label: driver.webApp.label,
      docs: driver.webApp.docs || '',
      containerPort: driver.webApp.containerPort,
      auth: driver.webApp.auth
        ? { label: driver.webApp.auth.label, hint: driver.webApp.auth.hint || '' }
        : null,
    },
    active,
    networkMode: netPeer,
    webService: active ? webService : null,
    passwordConfigured: active && !!password,
    authToken: redact ? '' : (active && driver.webApp.auth && driver.webApp.auth.urlToken ? password : ''),
    tokenConfigured: !!(active && driver.webApp.auth && driver.webApp.auth.urlToken && password),
    // The start command is built from the password, so it is a second copy of
    // the credential and is redacted with it. The MCP caller gets the port
    // instead, which is the part that is not a secret.
    startCommand: redact
      ? (active ? `[redacted: web start command for port ${webService.containerPort}]` : '')
      : (active ? driver.webApp.startCommand({ password, containerPort: webService.containerPort }) : ''),
    actualPorts,
    extraPorts,
    sshPort,
    sshContainerPort,
    draft: readDrafts(name),
  };
}
