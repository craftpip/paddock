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

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
const HOST_WORKSPACE = process.env.HOST_WORKSPACE_ROOT || WORKSPACE;
const INSTANCES_DIR = path.join(WORKSPACE, 'instances');

function runCmd(cmd, args, options = {}) {
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

async function inspectContainer(name) {
  try {
    const r = await runCmd('docker', ['inspect', name], { timeout: 15000 });
    const arr = JSON.parse(r.stdout);
    return Array.isArray(arr) ? arr[0] || null : null;
  } catch {
    return null;
  }
}

/** Resolved compose service definition (from `docker compose config`). */
async function resolveCompose(name) {
  try {
    const args = ['compose'];
    // Resolve the generated build.args interpolation from the instance build.env
    // (skip when the legacy agent has no build dir yet — defaults still apply).
    if (fs.existsSync(buildEnvPath(name))) args.push('--env-file', buildEnvPath(name));
    args.push('-f', composePath(name), 'config', '--format', 'json');
    const r = await runCmd('docker', args, { timeout: 20000 });
    const data = JSON.parse(r.stdout);
    return (data.services && data.services[name]) || null;
  } catch {
    return null;
  }
}

/** Resolve a container peer (name or id) to { name, id, state }. */
async function resolvePeer(peer) {
  try {
    const r = await runCmd('docker', ['inspect', peer, '--format', '{{.Name}}|{{.Id}}|{{.State.Status}}'], { timeout: 15000 });
    const [name, id, state] = (r.stdout || '').split('|');
    return { name: (name || '').replace(/^\//, ''), id: (id || '').trim(), state: (state || '').trim().toLowerCase() };
  } catch {
    return null;
  }
}

async function checkContainerHealth(name, onCheck) {
  const checks = [];
  const add = (check) => {
    checks.push(check);
    if (onCheck) onCheck(check);
  };

  const compose = await resolveCompose(name);
  const ctr = await inspectContainer(name);

  if (!compose) {
    add({
      key: 'compose', label: 'Compose file', status: 'error', expected: 'docker-compose.yml', actual: null,
      hint: `No compose file at ${composePath(name)} — recreate the agent to regenerate it.`,
    });
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
  if (expNet && expNet.startsWith('container:')) {
    const peerRef = expNet.slice('container:'.length).trim();
    const peer = await resolvePeer(peerRef);
    if (!peer) {
      add({
        key: 'network', label: 'Network peer', status: 'error', expected: expNet, actual: actNet,
        hint: `The network peer '${peerRef}' no longer exists (it was likely recreated). Recreate this container so it re-joins the current one.`,
      });
    } else if (peer.state !== 'running') {
      add({
        key: 'network', label: 'Network peer', status: 'error', expected: `${peerRef} (running)`, actual: `${peerRef} (${peer.state})`,
        hint: `The network peer '${peerRef}' is not running. Start it, then recreate this container.`,
      });
    } else if (actNet === `container:${peer.id}` || actNet === `container:${peerRef}`) {
      add({ key: 'network', label: 'Network mode', status: 'ok', expected: expNet, actual: actNet });
    } else {
      add({ key: 'network', label: 'Network mode', status: 'warn', expected: expNet, actual: actNet, hint: 'Container is bound to a different peer than the compose file. Recreate to rebind.' });
    }
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
      if (src && !fs.existsSync(webuiPath(src))) {
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
  const expPorts = Array.isArray(compose.ports) ? compose.ports : [];
  const actualPorts = (ctr.NetworkSettings && ctr.NetworkSettings.Ports) || {};
  if (!expPorts.length) {
    add({ key: 'ports', label: 'Ports', status: 'ok', expected: '(none)', actual: '(none)' });
  } else {
    const spec = expPorts.map((p) => (p && typeof p === 'object' ? `${p.published}:${p.target}` : String(p)));
    const missing = expPorts.filter((p) => {
      const published = p && typeof p === 'object' ? String(p.published) : null;
      if (!published) return false;
      return !actualPorts[`${published}/tcp`] && !actualPorts[`${published}/udp`];
    });
    if (missing.length) {
      add({ key: 'ports', label: 'Ports', status: 'error', expected: spec.join(', '), actual: Object.keys(actualPorts).join(', ') || '(none)', hint: `Published port(s) not bound: ${missing.map((p) => (p && typeof p === 'object' ? p.published : p)).join(', ')}. Recreate to fix.` });
    } else {
      add({ key: 'ports', label: 'Ports', status: 'ok', expected: spec.join(', '), actual: spec.join(', ') });
    }
  }

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

function summarize(name, checks) {
  const counts = { ok: 0, warn: 0, error: 0 };
  for (const c of checks) {
    if (counts[c.status] !== undefined) counts[c.status]++;
  }
  const status = counts.error ? 'error' : counts.warn ? 'warn' : 'ok';
  return { name, status, checks, counts };
}

module.exports = { checkContainerHealth, summarize };
