const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Read-only host-path probes for the Create Agent workspace source field
// (plan 40). Everything here answers "what does the webui container see?" —
// the one-to-one mount rule means a project folder mounted into paddock at the
// same path is identical in both namespaces, so a path that exists in the
// container is a valid host source for the Docker daemon.

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
const HOST_WORKSPACE = process.env.HOST_WORKSPACE_ROOT || WORKSPACE;

// Host dirs (and descendants) that must never be offered as a project /
// workspace source.
const SYSTEM_DIRS = ['/etc', '/proc', '/sys', '/dev', '/boot', '/bin', '/sbin', '/usr', '/lib', '/home', '/root', '/opt', '/tmp', '/var/run'];

// Paddock's own folders — visible in the container but never a user project.
// Only the exact mount points are blocked; their children (e.g. /workspace/…)
// stay reachable and are mapped back to host paths by hostPathOf().
const OWN_DIRS = ['/app', '/workspace'];

/** Map a HOST path onto the webui container's view. The project root lives at
 *  WORKSPACE in the container; everything else is assumed to be a one-to-one
 *  mount, so the path is unchanged. */
function containerPathOf(hostPath) {
  const norm = path.normalize(String(hostPath || ''));
  if (norm === HOST_WORKSPACE) return WORKSPACE;
  if (norm.startsWith(HOST_WORKSPACE + path.sep)) return WORKSPACE + norm.slice(HOST_WORKSPACE.length);
  return norm;
}

/** Reverse of containerPathOf(): container view → host path. */
function hostPathOf(containerPath) {
  const norm = path.normalize(String(containerPath || ''));
  if (norm === WORKSPACE) return HOST_WORKSPACE;
  if (norm.startsWith(WORKSPACE + path.sep)) return HOST_WORKSPACE + norm.slice(WORKSPACE.length);
  return norm;
}

function isForbidden(p) {
  const norm = path.normalize(p);
  if (SYSTEM_DIRS.some((s) => norm === s || norm.startsWith(s + '/'))) return true;
  return norm === '/app' || norm === '/workspace';
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function findComposeFile(dir) {
  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const p = path.join(dir, f);
    if (isFile(p)) return p;
  }
  return null;
}

function runCmd(cmd, args, options = {}) {
  const { timeout = 60000, cwd } = options;
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || '').trim() || err.message));
      else resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// D6: sources that must never be inherited into an agent container.
function isDangerousSource(src) {
  const s = path.normalize(String(src));
  if (s === '/var/run/docker.sock' || s.startsWith('/var/run/docker.sock/')) return true;
  return SYSTEM_DIRS.some((d) => s === d || s.startsWith(d + path.sep));
}

/** Discover the volumes a workspace folder's project exposes — compose file
 *  first (via `docker compose config`, resolved like the real deploy), then a
 *  supplement from any running/stopped containers of that compose project
 *  (`docker inspect` mounts not already covered by the file). Returns the
 *  normalized list for the Create Agent form to pre-fill. */
async function discoverVolumes(hostPath) {
  const raw = String(hostPath || '').trim();
  const norm = path.normalize(raw);
  const cpath = containerPathOf(norm);
  if (!isDir(cpath)) {
    throw new Error('Folder not found in paddock — mount the project folder one-to-one (same path in host and container) to use it');
  }
  const composeFile = findComposeFile(cpath);
  if (!composeFile) {
    return { path: norm, project: path.basename(cpath), compose: null, source: 'none', volumes: [], errors: [] };
  }

  const volumes = [];
  const seen = new Set();
  const push = (v) => {
    // Named volumes are identified by their container target (a volume at the
    // same destination is the same logical mount); binds by source + target.
    const key = v.type === 'volume' ? `volume:${v.target}` : `${v.type}:${v.source}:${v.target}`;
    if (seen.has(key)) return;
    seen.add(key);
    volumes.push(v);
  };

  let config = null;
  try {
    const r = await runCmd('docker', ['compose', '--project-directory', cpath, '-f', composeFile, 'config', '--format', 'json'], { timeout: 60000 });
    config = JSON.parse(r.stdout);
  } catch (err) {
    return { path: norm, project: path.basename(cpath), compose: hostPathOf(composeFile), source: 'compose', volumes: [], errors: [err.message] };
  }

  for (const [service, def] of Object.entries(config.services || {})) {
    for (const v of def.volumes || []) {
      if (v.type === 'tmpfs') continue;
      if (v.type === 'volume' && !v.source) continue; // anonymous volume — nothing to inherit
      if (isDangerousSource(v.source)) continue;
      push({
        type: v.type === 'volume' ? 'volume' : 'bind',
        // Bind sources are host paths — map the container view back (identity
        // for one-to-one mounts; only the paddock root at WORKSPACE changes).
        source: v.type === 'volume' ? v.source : hostPathOf(v.source || ''),
        // Dev-environment rule: binds pre-fill one-to-one (container path =
        // host path) so the agent sees the same filesystem layout as the host.
        // The compose's own container destination is ignored for binds.
        target: v.type === 'volume' ? v.target || '' : hostPathOf(v.source || ''),
        readonly: !!v.read_only,
        service,
        origin: 'compose',
      });
    }
  }

  // Project identity for the container label filter. Compose labels carry the
  // DIRECTORY name of the compose file (host view). config.name is usually that
  // same name, EXCEPT when the container path differs from the host path — the
  // one-to-one mount maps the paddock root to WORKSPACE, so config.name becomes
  // "workspace" and collides with any other container ever composed from a
  // directory named "workspace". Prefer the host dir name when they diverge.
  const hostName = path.basename(norm);
  const project = (config && config.name) || path.basename(cpath);
  const effectiveProject = config && project === path.basename(cpath) && hostName !== project ? hostName : project;
  try {
    const ps = await runCmd('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${effectiveProject}`, '--format', '{{.Names}}'], { timeout: 15000 });
    for (const cname of ps.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      const ins = await runCmd('docker', ['inspect', cname], { timeout: 15000 });
      const arr = JSON.parse(ins.stdout);
      const c = Array.isArray(arr) ? arr[0] : null;
      for (const m of (c && c.Mounts) || []) {
        if (m.Type === 'tmpfs') continue;
        if (m.Type === 'volume' && !(m.Name || m.Source)) continue;
        if (isDangerousSource(m.Source)) continue;
        push({
          type: m.Type === 'volume' ? 'volume' : 'bind',
          // For named volumes `Name` is the real Docker volume (e.g.
          // mempalace-dbdata); `Source` is its host backing dir.
          source: m.Type === 'volume' ? (m.Name || m.Source) : (m.Source || ''),
          // Binds pre-fill one-to-one (container path = host path) — see the
          // compose pass above.
          target: m.Type === 'volume' ? m.Destination || '' : (m.Source || ''),
          readonly: !m.RW,
          service: cname,
          origin: 'container',
        });
      }
    }
  } catch {}

  // Annotate named volumes with the full Docker volume name to attach
  // (`external`, compose-derived for file volumes, the volume's own name for
  // container volumes) and whether it exists right now — so the pre-filled
  // form can distinguish "attach the project's real data" from "fresh volume".
  await Promise.all(volumes
    .filter((v) => v.type === 'volume')
    .map(async (v) => {
      const external = v.origin === 'container' ? v.source : `${effectiveProject}_${v.source}`;
      v.external = external;
      v.exists = await volumeExists(external);
    }));

  return {
    path: norm,
    project: effectiveProject,
    compose: hostPathOf(composeFile),
    source: 'compose',
    volumes,
    errors: [],
  };
}

/** Whether a named Docker volume currently exists (cheap `docker volume
 *  inspect`). Used to tag discovered named volumes with their attach-ability. */
async function volumeExists(name) {
  try {
    await runCmd('docker', ['volume', 'inspect', name], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/** Validate + describe a host path for the workspace source field. */
function probe(hostPath) {
  const raw = String(hostPath || '').trim();
  if (!raw) return { path: '', exists: false, isDir: false, writable: false, forbidden: false, compose: null };
  const norm = path.normalize(raw);
  const cpath = containerPathOf(norm);
  const exists = isDir(cpath);
  const compose = exists ? findComposeFile(cpath) : null;
  let writable = false;
  if (exists) {
    try { fs.accessSync(cpath, fs.constants.W_OK); writable = true; } catch {}
  }
  return {
    path: norm,
    exists,
    isDir: exists,
    writable,
    forbidden: isForbidden(norm) || isForbidden(cpath),
    compose: compose ? hostPathOf(compose) : null,
  };
}

/** Autocomplete suggestions for a typed prefix: the subdirectories of the
 *  deepest existing ancestor of `q`, hidden-filtered and mapped back to host
 *  paths. The client filters the returned list against the typed text. */
function autocomplete(q) {
  const raw = String(q || '').trim();
  let typed = raw === '' ? '/' : path.normalize(raw.replace(/\/{2,}/g, '/'));
  if (typed === '.' || typed === '..') typed = '/';
  const cpath = containerPathOf(typed);
  let base = cpath;
  if (!isDir(base)) {
    let found = '';
    const parts = cpath.split('/').filter(Boolean);
    for (let i = parts.length; i >= 0; i--) {
      const candidate = '/' + parts.slice(0, i).join('/');
      if (isDir(candidate)) { found = candidate; break; }
    }
    base = found || '/';
  }
  let dirs = [];
  if (isDir(base)) {
    try {
      dirs = fs.readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => hostPathOf(path.join(base, e.name)))
        .filter((p) => !isForbidden(p))
        .sort((a, b) => a.localeCompare(b));
    } catch { dirs = []; }
  }
  return { base: hostPathOf(base), dirs };
}

module.exports = { probe, autocomplete, discoverVolumes, containerPathOf, hostPathOf, isForbidden, isDangerousSource, findComposeFile };
