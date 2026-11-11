const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const apiKeys = require('./api-keys');
const { getDb } = require('./db');
const { getDriverOr, getMcp } = require('./drivers');
const { getPaddockMcpUrl } = require('./paddock-mcp');
const { ensureOwned } = require('./ownership');
const vm = require('./vm-manager');

/** Orchestrator conferral (plan 52 Phase D). An ordinary PAD is conferred the
 *  orchestrator role by ONE action that, together, is the role:
 *
 *    1. an API key named `orchestrator` is created for the agent's owner with
 *       the FULL reach that key can have (`default` — the user chose full
 *       control, incl. recreate/destroy, for the conferral key);
 *    2. the paddock MCP server is wired into the pad's own config with that
 *       key as its bearer token, by running the driver's own `mcp` builder
 *       inside the running container (plan 35b generated the builders, so the
 *       per-driver config grammar stays in the drivers);
 *    3. an `orchestrator.json` identity record is written next to the pad's
 *       driver config (the durable marker Phase E reads for inventory), and
 *    4. `ORCHESTRATOR=1` is stamped in the pad's meta.env.
 *
 *  "Remove" reverses all four. The role is stored as a key + a config record +
 *  a meta flag, never as a new agent type — an orchestrator is an ordinary PAD
 *  and only its KEY differs from a worker's.
 *
 *  A driver that cannot be resolved, or that returns no connect builder, is an
 *  error rather than a silent pass: "Make orchestrator" promised a key AND a
 *  working MCP server, so leaving the pad unwired while stamping the role would
 *  be a conferral that does not confer. */

const ORCH_KEY_NAME = 'orchestrator';
const ORCH_META_KEY = 'ORCHESTRATOR';

/** An error with a machine code + HTTP status, mirroring mission.js. */
class OrchestratorError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Run the driver's MCP builder inside a running pad with the key on stdin.
 *  Kept as an injectable seam so the suite can record the exact argv+docker
 *  call without needing a container.
 *
 *  DELIBERATELY spawn, not execFile: `execFile(..., { input })` HANGS here.
 *  The paddock container's docker CLI reads the piped stdin of `docker exec -i`
 *  differently from a real shell pipe — measured live: a trivial
 *  `IFS= read -r X` blocks forever under execFile+input yet completes under
 *  `spawn` + `child.stdin.write/end` and under `printf | docker exec -i`. The
 *  same reported pairing (openssh the key from stdin, "use spawn, not
 *  execFile") is already an AGENTS.md watch item for the openclaw auth path. */
/** The `docker exec` argv for `execInPad`, split out so the plan-89 drop is
 *  testable without a container (the same shape as mcp.js's `execDockerArgs`).
 *  Plan 89: `opencode mcp add` initializes opencode, which creates
 *  `$HOME/.local/state/opencode/locks`. Run as root in a user-mode PAD and those
 *  locks land root-owned (0700), so the pad user's own sessions later die with
 *  PermissionDenied. Drop to the pad user exactly like pad-tmux does; a root-mode
 *  PAD yields no extra argv. */
function execDockerArgs(name, script) {
  return ['exec', '-i', ...require('./pad-tmux').termUserArgs(name), name, 'sh', '-lc', script];
}

function execInPad(name, script, input) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('docker', execDockerArgs(name, script));
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    // A hung attach must become a FAILURE, not a promise that never settles:
    // confer()'s rollback only runs on rejection, and a full-reach key left
    // behind by a request that never returned is an orphan. 60s is far past
    // any real `mcp add` on a running pad.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('docker exec timed out after 60s'), { stdout, stderr }));
    }, 60000);
    timer.unref();
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const err = new Error(`docker exec exited ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
    child.stdin.write(input || '');
    child.stdin.end();
  });
}
let execRunner = execInPad;
function _setExecRunner(fn) { execRunner = fn ? fn : execInPad; }

/** Host path of the pad's orchestrator identity record, next to its driver
 *  config inside the bind-mounted data dir. */
function orchestratorConfigPath(name) {
  const driver = getDriverOr(getAgentType(name));
  return path.join(path.dirname(vm.driverConfigPath(name, driver)), 'orchestrator.json');
}

function getAgentType(name) {
  const row = getDb().prepare('SELECT agent_type FROM agents WHERE name = ?').get(name);
  return (row && row.agent_type) || '';
}

function readConfigOrNull(name) {
  const p = orchestratorConfigPath(name);
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function isConferred(name) {
  return !!readConfigOrNull(name) || vm.readMeta(path.join(vm.INSTANCES_DIR, name)).ORCHESTRATOR === '1';
}

/** The user's unrevoked orchestrator key row, if any. */
function orchestratorKey(userId) {
  return apiKeys.listForUser(userId).find((k) => k.name === ORCH_KEY_NAME && !k.revoked_at) || null;
}

/** The pad this user's orchestrator key is conferring, when it is not `name`
 *  (so a second conferral can name the one that already exists). */
function otherConferredPad(userId, name) {
  const names = getDb().prepare('SELECT name FROM agents WHERE owner_id = ?').all(userId).map((r) => r.name);
  for (const n of names) {
    if (n === name) continue;
    if (vm.readMeta(path.join(vm.INSTANCES_DIR, n)).ORCHESTRATOR === '1') return n;
  }
  return '';
}

/** Make an ordinary PAD the user's orchestrator. `userId` is the conferring
 *  user (the agent's own owner is enforced by the route). */
async function confer(name, userId) {
  if (isConferred(name)) {
    throw new OrchestratorError(409, 'already_orchestrator', `${name} is already an orchestrator`);
  }
  // The key written into the PAD carries the CONFERRING user's reach. Putting
  // an admin's key into a PAD another user owns would hand that user the
  // admin's access, so only the PAD's own owner may confer (an ownerless PAD
  // belongs to whoever administers it).
  const owner = getDb().prepare('SELECT owner_id FROM agents WHERE name = ?').get(name);
  if (owner && owner.owner_id && owner.owner_id !== userId) {
    throw new OrchestratorError(403, 'not_pad_owner',
      `${name} belongs to another user. Only its owner can make it an orchestrator, because the PAD would hold a key with your access.`);
  }
  const elsewhere = otherConferredPad(userId, name);
  if (elsewhere) {
    throw new OrchestratorError(409, 'orchestrator_exists',
      `You already have an orchestrator: ${elsewhere}. Remove it before conferring ${name}.`);
  }

  const type = getAgentType(name);
  const driver = getDriverOr(type);
  const mcp = getMcp(driver.type, getPaddockMcpUrl());
  const connect = mcp.commands.connect;
  if (!connect) {
    throw new OrchestratorError(400, 'mcp_not_supported', `${type} has no paddock MCP connect command`);
  }

  const running = await vm.isContainerRunning(name);
  if (!running) {
    throw new OrchestratorError(409, 'agent_stopped',
      `Start ${name} first — the orchestrator MCP server is wired into its running container.`);
  }

  const { key, row } = apiKeys.create(userId, ORCH_KEY_NAME, 'default');
  const configPath = orchestratorConfigPath(name);
  let wired = false;
  try {
    await execRunner(name, connect, key);
    wired = true;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath,
      // keyId / keyUserId say exactly which key to revoke later, whoever
      // removes the conferral. Neither is a secret.
      JSON.stringify({ role: 'orchestrator', since: new Date().toISOString(), folders: [], keyId: row.id, keyUserId: userId }, null, 2) + '\n');
    ensureOwned(configPath);
    vm.setMetaFlag(name, ORCH_META_KEY, '1');
  } catch (e) {
    // Roll the role back so a half-conferral is impossible.
    apiKeys.remove(row.id, userId);
    try { if (fs.existsSync(configPath)) fs.rmSync(configPath); } catch {}
    try { vm.setMetaFlag(name, ORCH_META_KEY, ''); } catch {}
    throw new OrchestratorError(500, 'orchestrator_wiring_failed',
      `Created the key but could not wire paddock MCP into ${name}: ${e.message}`);
  }
  return {
    ok: true,
    name,
    keyName: ORCH_KEY_NAME,
    keyId: row.id,
    keyCreatedAt: row.created_at,
    wired,
    since: readConfigOrNull(name)?.since || null,
  };
}

/** Reverse a conferral: revoke the key, un-wire the paddock MCP server
 *  (best-effort — a stopped pad keeps an inert entry that a revoked key
 *  cannot authorize), and drop the config + meta flag. */
async function removeConferral(name, userId) {
  if (!isConferred(name)) {
    throw new OrchestratorError(409, 'not_orchestrator', `${name} is not an orchestrator`);
  }
  // Revoke the key this conferral minted, by id. Looking it up by the
  // CALLER and the name "orchestrator" left the real key valid when a
  // different admin removed the conferral, and could delete a key the caller
  // had made by hand under that name.
  const recorded = readConfigOrNull(name) || {};
  let keyRevoked = false;
  if (recorded.keyId && recorded.keyUserId) {
    keyRevoked = apiKeys.remove(recorded.keyId, recorded.keyUserId);
  } else {
    // A conferral made before the id was recorded: the old lookup is all there is.
    const key = orchestratorKey(userId);
    if (key) keyRevoked = apiKeys.remove(key.id, userId);
  }

  let wiringLeftInContainer = false;
  try {
    const type = getAgentType(name);
    const driver = getDriverOr(type);
    const mcp = getMcp(driver.type, getPaddockMcpUrl());
    const disconnect = mcp.commands.disconnect;
    const running = await vm.isContainerRunning(name);
    if (disconnect && running) {
      await execRunner(name, disconnect, '');
    } else if (disconnect && !running) {
      // The container is down; its config (host mount) still lists the paddock
      // server with a now-revoked key — harmless, cleaned next conferral/start.
      wiringLeftInContainer = true;
    }
  } catch {
    wiringLeftInContainer = true;
  }

  const configPath = orchestratorConfigPath(name);
  try { if (fs.existsSync(configPath)) fs.rmSync(configPath); } catch {}
  try { vm.setMetaFlag(name, ORCH_META_KEY, ''); } catch {}
  return { ok: true, name, keyRevoked, wiringLeftInContainer };
}

/** Read the conferral state for the UI. */
function getOrchestrator(name, userId) {
  const conferred = isConferred(name);
  const cfg = readConfigOrNull(name) || { since: null, folders: [] };
  const key = orchestratorKey(userId);
  return {
    conferred,
    name,
    keyName: ORCH_KEY_NAME,
    since: cfg.since || null,
    folders: Array.isArray(cfg.folders) ? cfg.folders : [],
    keyId: key ? key.id : null,
    keyCreatedAt: key ? key.created_at : null,
    keyLastUsedAt: key ? key.last_used_at : null,
  };
}

module.exports = { confer, removeConferral, getOrchestrator, isConferred, orchestratorConfigPath, OrchestratorError, _setExecRunner, execDockerArgs };