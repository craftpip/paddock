/**
 * Generic Docker-level container health check. No agent/driver knowledge:
 * it diffs the *declared* settings (`docker compose config`) against the
 * *actual* container (`docker inspect`) and reports what's out of line.
 *
 * Each check has: { key, label, status: 'ok'|'warn'|'error', expected, actual, hint }
 *
 * `checkContainerHealth(name, onCheck?)` — when `onCheck` is given, it is
 * called with each check as it is produced so a caller can stream the results
 * live (health-check job). Without it, the full report is returned at once.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { buildEnvPath } = require('./instance-image');
const { inspectPeer, classifyNetworkPeer } = require('./net-peer');

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
const HOST_WORKSPACE = process.env.HOST_WORKSPACE_ROOT || WORKSPACE;
const INSTANCES_DIR = path.join(WORKSPACE, 'instances');

/** Test seam: the docker call. */
let runCmd = defaultRunCmd;
function _setRunner(fn) { runCmd = fn || defaultRunCmd; }

function defaultRunCmd(cmd, args, options = {}) {
  const { timeout = 20000 } = options;
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function composePath(name) {
  return path.join(INSTANCES_DIR, name, 'docker-compose.yml');
}

/** Translate a daemon-side host path into the path the webui container sees
 *  (e.g. /www2/paddock/... → /workspace/...) for local fs checks. */
function webuiPath(hostPath) {
  if (HOST_WORKSPACE && hostPath && hostPath.startsWith(HOST_WORKSPACE)) {
    return path.join(WORKSPACE, hostPath.slice(HOST_WORKSPACE.length));
  }
  return hostPath;
}

/** First line of whatever a failed command said. */
function whyFailed(e) {
  return String((e && (e.stderr || e.message)) || e || 'unknown error').trim().split('\n')[0].slice(0, 300);
}

/** Look a container up. Three answers, never two:
 *    { ctr }            it exists, here it is
 *    { ctr: null }      docker says there is no such container
 *    { ctr: null, unknown: '<why>' }   docker could not be asked
 *  The last one used to be folded into the second, so a daemon that was briefly
 *  unreachable (or a 15 s timeout) produced "Container exists: not found —
 *  start or recreate it" for a healthy PAD, on the Health tab and to any LLM
 *  calling the health tool. */
async function lookupContainer(name) {
  try {
    const r = await runCmd('docker', ['inspect', name], { timeout: 15000 });
    const arr = JSON.parse(r.stdout);
    return { ctr: Array.isArray(arr) ? arr[0] || null : null };
  } catch (e) {
    if (/no such (object|container)/i.test(String((e && (e.stderr || e.message)) || ''))) return { ctr: null };
    return { ctr: null, unknown: whyFailed(e) };
  }
}

/** Resolved compose service definitions (from `docker compose config`). */
/** `{ services }` when the declaration was read; `{ services: null, missing: true }`
 *  when there is no compose file; `{ services: null, error }` when there IS one
 *  and it could not be resolved (a bad build.env, a compose error, a daemon
 *  that did not answer). Only the middle one means "recreate to regenerate". */
async function resolveCompose(name) {
  if (!fs.existsSync(composePath(name))) return { services: null, missing: true };
  try {
    const args = ['compose'];
    // Resolve the generated build.args interpolation from the instance build.env
    // (skip when the legacy agent has no build dir yet — defaults still apply).
    if (fs.existsSync(buildEnvPath(name))) args.push('--env-file', buildEnvPath(name));
    args.push('-f', composePath(name), 'config', '--format', 'json');
    const r = await runCmd('docker', args, { timeout: 20000 });
    const data = JSON.parse(r.stdout);
    return { services: data.services || {} };
  } catch (e) {
    return { services: null, error: whyFailed(e) };
  }
}

/** The published-ports check, as a pure function of the compose services and
 *  the live inspect results, so it is testable without a docker daemon.
 *
 *  A peer-mode agent publishes NOTHING itself — every declared port rides on its
 *  `-door` sidecar, which is the only container that actually binds them. Reading
 *  the agent service/ctr there reports "(none)" for a fully working pad, so the
 *  door is the port-bearing unit whenever it exists. */
function checkPublishedPorts(compose, ctr, door, doorCtr) {
  const portUnit = door ? { compose: door, ctr: doorCtr, label: 'Ports (via door)' } : { compose, ctr, label: 'Ports' };
  const expPorts = Array.isArray(portUnit.compose && portUnit.compose.ports) ? portUnit.compose.ports : [];
  const actualPorts = (portUnit.ctr && portUnit.ctr.NetworkSettings && portUnit.ctr.NetworkSettings.Ports) || {};
  if (!expPorts.length) {
    if (door && !doorCtr) {
      // The door is gone, so its declared ports cannot be verified at all.
      // Saying "(none)" here would read as healthy; say what is actually true.
      return { key: 'ports', label: portUnit.label, status: 'warn', expected: 'see compose', actual: 'not verifiable (door missing)', hint: 'The forwarding door is gone, so these published ports cannot be checked. Recreate to restore it.' };
    }
    return { key: 'ports', label: portUnit.label, status: 'ok', expected: '(none)', actual: '(none)' };
  }
  const spec = expPorts.map((p) => (p && typeof p === 'object' ? `${p.published}:${p.target}` : String(p)));
  const missing = expPorts.filter((p) => {
    if (!p || typeof p !== 'object') return false;
    const target = p.target != null ? String(p.target) : '';
    const published = p.published != null ? String(p.published) : '';
    const proto = p.protocol || 'tcp';
    if (!published || !target) return false; // exposed-only ports have nothing to verify
    const bindings = actualPorts[`${target}/${proto}`] || [];
    return !bindings.some((b) => b && String(b.HostPort) === published);
  });
  if (missing.length) {
    // `Object.keys(...).join(', ')` is empty when nothing at all is bound, which
    // rendered as "(none)" and read like "this pad publishes nothing" — the
    // opposite of the truth when ports ARE declared.
    const bound = Object.keys(actualPorts).filter((k) => (actualPorts[k] || []).length).join(', ');
    const actual = bound || 'none bound';
    return { key: 'ports', label: portUnit.label, status: 'error', expected: spec.join(', '), actual, hint: `Published port(s) not bound: ${missing.map((p) => (p && typeof p === 'object' ? p.published : p)).join(', ')}. Recreate to fix.` };
  }
  return { key: 'ports', label: portUnit.label, status: 'ok', expected: spec.join(', '), actual: spec.join(', ') };
}

async function checkContainerHealth(name, onCheck) {
  const checks = [];
  const add = (check) => {
    checks.push(check);
    if (onCheck) onCheck(check);
  };

  const declared = await resolveCompose(name);
  const services = declared.services;
  const compose = services && services[name];
  const looked = await lookupContainer(name);
  const ctr = looked.ctr;

  // A compose file we could not read is not a fact about the container. Every
  // check after the container block derives its EXPECTATION from it, so with no
  // compose there is nothing to compare against — and the old code carried on and
  // dereferenced `null`, so a pad with no compose file reported a TypeError
  // instead of the container facts it had just established. Record it, and
  // resume once the compose-independent checks are in.
  const composeMissing = !compose;
  if (composeMissing && declared.error) {
    // The file is there; reading it failed. Saying "no compose file, recreate"
    // here would send someone to rebuild a PAD over a typo in build.env.
    add({
      key: 'compose', label: 'Compose file', status: 'warn', checked: false, expected: 'docker-compose.yml', actual: 'could not be read',
      hint: `The compose file at ${composePath(name)} exists but could not be resolved: ${declared.error}. Nothing was compared against it; this is not a reason to recreate the agent.`,
    });
  } else if (composeMissing && services) {
    // The file resolves; it just does not declare this PAD. Not "no file".
    add({
      key: 'compose', label: 'Compose file', status: 'error', expected: `a service named ${name}`, actual: Object.keys(services).join(', ') || '(no services)',
      hint: `The compose file at ${composePath(name)} has no service named ${name}, so there is nothing to compare the container against. Recreate the agent to regenerate it.`,
    });
  } else if (composeMissing) {
    add({
      key: 'compose', label: 'Compose file', status: 'error', expected: 'docker-compose.yml', actual: null,
      hint: `No compose file at ${composePath(name)} — recreate the agent to regenerate it. The container facts below are real; every check that compares the declaration against the container was skipped.`,
    });
  }

  if (!ctr && looked.unknown) {
    add({
      key: 'container', label: 'Container exists', status: 'warn', checked: false, expected: 'created', actual: 'could not check',
      hint: `Docker did not answer (${looked.unknown}), so nothing is known about this container right now. Run the check again; do not recreate on this result.`,
    });
    return summarize(name, checks);
  }
  if (!ctr) {
    add({
      key: 'container', label: 'Container exists', status: 'error', expected: 'created', actual: 'not found',
      hint: 'The container does not exist. Start or recreate it.',
    });
    return summarize(name, checks);
  }

  // ── Container state ─────────────────────────────────────────
  const state = ctr.State || {};
  if (state.Running === true) {
    add({ key: 'container', label: 'Container status', status: 'ok', expected: 'running', actual: 'running' });
  } else {
    const why = [];
    if (state.OOMKilled) why.push('OOM-killed');
    if (state.Error) why.push(state.Error);
    if (state.ExitCode) why.push(`exit code ${state.ExitCode}`);
    add({
      key: 'container', label: 'Container status', status: 'error',
      expected: 'running', actual: `stopped (${why.join(', ') || 'not running'})`,
      hint: why.length ? `The container stopped: ${why.join(', ')}. Check the Logs tab.` : 'The container is stopped. Start it from the dashboard.',
    });
  }

  // ── Docker healthcheck (the /healthz probe) ────────────────
  if (state.Health) {
    const hs = state.Health.Status || '';
    if (hs === 'healthy') {
      add({ key: 'health', label: 'Health check', status: 'ok', expected: 'healthy', actual: hs });
    } else if (hs === 'starting') {
      add({ key: 'health', label: 'Health check', status: 'warn', expected: 'healthy', actual: 'starting', hint: 'Still warming up — this clears on its own.' });
    } else {
      add({ key: 'health', label: 'Health check', status: 'error', expected: 'healthy', actual: hs || 'unknown', hint: 'The container health probe is failing. Check the Logs tab.' });
    }
  }

  // Everything below compares the DECLARATION against the container, so with no
  // readable compose there is nothing to compare to. Stop here rather than
  // dereferencing a null and reporting a TypeError in place of a report.
  if (composeMissing) return summarize(name, checks);

  // ── Restart policy ─────────────────────────────────────────
  const rp = (ctr.HostConfig && ctr.HostConfig.RestartPolicy) || {};
  const expRestart = (compose.restart || '').trim() || 'no';
  const actRestart = rp.Name || 'no';
  if (expRestart === actRestart) {
    add({ key: 'restart', label: 'Restart policy', status: 'ok', expected: expRestart, actual: actRestart });
  } else {
    add({ key: 'restart', label: 'Restart policy', status: 'error', expected: expRestart, actual: actRestart, hint: 'Container was created with a different restart policy. Recreate to fix.' });
  }

  // ── Image ──────────────────────────────────────────────────
  const expImage = compose.image || '';
  const actImage = (ctr.Config && ctr.Config.Image) || '';
  if (!expImage) {
    add({ key: 'image', label: 'Image', status: 'warn', expected: '(none declared)', actual: actImage });
  } else if (expImage === actImage) {
    add({ key: 'image', label: 'Image', status: 'ok', expected: expImage, actual: actImage });
  } else {
    add({ key: 'image', label: 'Image', status: 'warn', expected: expImage, actual: actImage, hint: 'Container runs a different image than the compose file declares. Recreate to align.' });
  }

  // ── Network mode / peer ────────────────────────────────────
  const expNet = compose.network_mode || '';
  const actNet = (ctr.HostConfig && ctr.HostConfig.NetworkMode) || '';

  const drift = networkModeDrift(expNet, actNet);
  if (drift) {
    add({ key: 'network', label: 'Network mode', status: 'error', expected: expNet || 'default', actual: actNet || 'default', hint: drift });
  } else if (expNet && expNet.startsWith('container:')) {
    // The SAME classification settings_get uses, on the same inputs — so the
    // two cannot drift into disagreeing about one pad (plan 66). The compose
    // file names the peer; the live container records the id it was bound to.
    const declaredRef = expNet.slice('container:'.length).trim();
    const verdict = classifyNetworkPeer({
      mode: actNet,
      bound: await inspectPeer(actNet.startsWith('container:') ? actNet.slice('container:'.length).trim() : ''),
      declaredRef,
      declared: await inspectPeer(declaredRef),
    });

    // Presentation is health's own business; the VERDICT is not. A pad bound to
    // a dead id while its peer runs is a warning about the binding, not an error
    // about the peer — recreating the peer would change nothing at all.
    const STATUS = { ok: 'ok', staleBinding: 'warn', 'peer-stopped': 'error', stale: 'error' };
    add({
      key: 'network',
      label: verdict.state === 'ok' ? 'Network mode' : 'Network peer',
      status: STATUS[verdict.state] || 'error',
      expected: verdict.peerName ? `${verdict.peerName} (${verdict.peerState})` : expNet,
      actual: actNet,
      peerName: verdict.peerName,
      peerState: verdict.peerState,
      peerCurrentId: verdict.peerCurrentId,
      staleBinding: verdict.staleBinding,
      hint: verdict.state === 'ok' ? undefined : verdict.reason,
    });
  } else if (expNet) {
    const networks = Object.keys((ctr.NetworkSettings && ctr.NetworkSettings.Networks) || {});
    if (networks.includes(expNet)) {
      add({ key: 'network', label: 'Network mode', status: 'ok', expected: expNet, actual: expNet });
    } else {
      add({ key: 'network', label: 'Network mode', status: 'error', expected: expNet, actual: networks.join(', ') || '(none)', hint: `Container is not attached to network '${expNet}'. Recreate to fix.` });
    }
  } else {
    add({ key: 'network', label: 'Network mode', status: 'ok', expected: 'default', actual: actNet || 'default' });
  }

  // ── Peer-network forwarding door ───────────────────────────
  const door = services && services[`${name}-door`];
  const doorContainer = door ? (door.container_name || `${name}-door`) : null;
  const doorLooked = doorContainer ? await lookupContainer(doorContainer) : { ctr: null };
  const doorCtr = doorLooked.ctr;
  if (door) {
    if (!doorCtr && doorLooked.unknown) {
      add({
        key: 'door', label: 'Forwarding door', status: 'warn', checked: false,
        expected: `${doorContainer} (running)`, actual: 'could not check',
        hint: `Docker did not answer for the forwarding door (${doorLooked.unknown}). Run the check again.`,
      });
    } else if (!doorCtr) {
      add({
        key: 'door', label: 'Forwarding door', status: 'error',
        expected: `${doorContainer} (running)`, actual: 'not found',
        hint: 'The forwarding door is missing, so published web and SSH ports cannot reach this agent. Recreate to restore it.',
      });
    } else if (!(doorCtr.State || {}).Running) {
      add({
        key: 'door', label: 'Forwarding door', status: 'error',
        expected: `${doorContainer} (running)`, actual: `${doorContainer} (${(doorCtr.State || {}).Status || 'stopped'})`,
        hint: 'The forwarding door is stopped, so published web and SSH ports cannot reach this agent. Recreate to restore it.',
      });
    } else {
      add({ key: 'door', label: 'Forwarding door', status: 'ok', expected: `${doorContainer} (running)`, actual: `${doorContainer} (running)` });
    }
  }

  // ── Volumes / bind mounts ──────────────────────────────────
  const expVols = Array.isArray(compose.volumes) ? compose.volumes : [];
  const mounts = ctr.Mounts || [];
  if (!expVols.length) {
    add({ key: 'volumes', label: 'Volumes', status: 'ok', expected: '(none)', actual: '(none)' });
  } else {
    for (const v of expVols) {
      const src = v.source;
      const dst = v.target;
      const label = `Volume ${path.basename(src || '?')} → ${dst}`;
      if (src && src.startsWith(WORKSPACE + '/')) {
        add({
          key: `volume:${dst}`, label, status: 'error', expected: src, actual: src,
          hint: 'Bind source is a /workspace path — the Docker daemon resolves that at the host root, not the project. This is a path split-brain; the webui and container won\u2019t see the same files.',
        });
        continue;
      }
      const webuiCanSee = src && HOST_WORKSPACE && src.startsWith(HOST_WORKSPACE + path.sep);
      if (src && webuiCanSee && !fs.existsSync(webuiPath(src))) {
        add({
          key: `volume:${dst}`, label, status: 'warn', expected: src, actual: '(missing on host)',
          hint: `Host path '${src}' does not exist. Docker will create it empty — this is usually fine on first boot.`,
        });
        continue;
      }
      const m = mounts.find((mm) => mm.Destination === dst);
      if (!m) {
        add({ key: `volume:${dst}`, label, status: 'error', expected: src || '', actual: '(not mounted)', hint: `Container has no mount at ${dst}. Recreate to fix.` });
        continue;
      }
      const srcOk = !src || m.Source === src || m.Source === path.resolve(src);
      add({
        key: `volume:${dst}`, label, status: srcOk ? 'ok' : 'warn',
        expected: src || '', actual: m.Source || '',
        hint: srcOk ? '' : 'Mount source differs from the compose file. Recreate to fix.',
      });
    }
  }

  // ── Docker socket (docker-inside-container) ────────────────
  const expectsSocket = expVols.some((v) => (v.source || '').includes('/var/run/docker.sock') || (v.target || '') === '/var/run/docker.sock');
  if (expectsSocket) {
    const sock = mounts.some((m) => (m.Source || '').includes('/var/run/docker.sock'));
    add({ key: 'docker-socket', label: 'Docker socket', status: sock ? 'ok' : 'error', expected: '/var/run/docker.sock', actual: sock ? 'mounted' : 'not mounted', hint: sock ? '' : 'The compose file mounts the docker socket but the container does not have it. Recreate to fix.' });
  }

  // ── Published ports ────────────────────────────────────────
  // `docker compose config` emits port objects { target, published, protocol }
  // where `target` is the CONTAINER port and `published` is the HOST port.
  // NetworkSettings.Ports is keyed by CONTAINER port (`target/protocol`) and
  // each binding carries { HostPort }. We must resolve host→container, not
  // look up the published port as if it were the key.
  //
  // A peer-mode agent publishes NOTHING itself — every declared port rides on
  // its `-door` sidecar, which is the only container that actually binds them.
  // Reading the agent service/ctr there reports "(none)" for a fully working
  // pad, so pick the door as the port-bearing unit whenever it exists.
  const portCheck = checkPublishedPorts(compose, ctr, door, doorCtr);
  add(portCheck);

  // ── Environment (keys only, secrets excluded) ─────────────
  const expEnv = compose.environment || {};
  const actEnv = (ctr.Config && ctr.Config.Env) || [];
  const actEnvMap = {};
  for (const e of actEnv) {
    const i = e.indexOf('=');
    if (i > -1) actEnvMap[e.slice(0, i)] = e.slice(i + 1);
  }
  const envKeys = Object.keys(expEnv).filter((k) => !/(password|token|key|secret)/i.test(k));
  const missingEnv = envKeys.filter((k) => !(k in actEnvMap));
  if (!envKeys.length) {
    add({ key: 'env', label: 'Environment', status: 'ok', expected: '(none)', actual: '(none)' });
  } else if (missingEnv.length) {
    add({ key: 'env', label: 'Environment', status: 'warn', expected: envKeys.join(', '), actual: `missing: ${missingEnv.join(', ')}`, hint: `Recreate the container to apply: ${missingEnv.join(', ')}.` });
  } else {
    add({ key: 'env', label: 'Environment', status: 'ok', expected: envKeys.join(', '), actual: envKeys.join(', ') });
  }

  return summarize(name, checks);
}

/** The KIND of networking the compose file declares against the kind the
 *  container actually has. Returns a sentence when they differ, else ''.
 *
 *  Comparing the kinds comes first because the peer classification below only
 *  rules on a container that IS peer-bound: handed a container on its own
 *  bridge it answered `ok`, so "settings switched to peer networking, recreate
 *  never happened" showed a green row reading `expected container:pad-x,
 *  actual pad-y_default`. The reverse (declared default, still bound to a
 *  peer) was unconditionally ok as well. */
function networkModeDrift(expected, actual) {
  const wantsPeer = String(expected || '').startsWith('container:');
  const hasPeer = String(actual || '').startsWith('container:');
  if (wantsPeer && !hasPeer) {
    return `The compose file shares ${expected.slice('container:'.length)}'s network, but the container is running on its own (${actual || 'default'}). Recreate to apply the declared networking.`;
  }
  if (!wantsPeer && hasPeer) {
    return `The compose file gives this agent its own network, but the container is still bound to another container's (${actual}). Recreate to apply the declared networking.`;
  }
  return '';
}

function summarize(name, checks) {
  const counts = { ok: 0, warn: 0, error: 0 };
  for (const c of checks) {
    if (counts[c.status] !== undefined) counts[c.status]++;
  }
  const status = counts.error ? 'error' : counts.warn ? 'warn' : 'ok';
  return { name, status, checks, counts };
}

module.exports = { checkContainerHealth, checkPublishedPorts, summarize, networkModeDrift, _setRunner };
