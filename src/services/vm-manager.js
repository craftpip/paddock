const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { runCmdStream } = require('./cmd');

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
const HOST_WORKSPACE = process.env.HOST_WORKSPACE_ROOT || WORKSPACE;
const INSTANCES_DIR = path.join(WORKSPACE, 'instances');
const PREFIX = process.env.CONTAINER_PREFIX || 'vm';
const PREFIX_RE = new RegExp('^' + PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-');

const AGENT_IMAGES = {
  openclaw: 'paddock-vm-openclaw:latest',
  picoclaw: 'paddock-vm-picoclaw:latest',
  nanobot: 'paddock-vm-nanobot:latest',
  hermes: 'paddock-vm-hermes:latest',
};

const AGENT_BUILD_REL = {
  openclaw: '../../src/vm-builds/openclaw',
  picoclaw: '../../src/vm-builds/picoclaw',
  nanobot: '../../src/vm-builds/nanobot',
  hermes: '../../src/vm-builds/hermes',
};

function containerDataDir(agent) {
  return agent === 'hermes' ? '/opt/data' : `/root/.${agent}`;
}

function runCmd(cmd, args, options = {}) {
  const { timeout = 120000 } = options;
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function readMeta(vmDir) {
  const meta = {};
  const metaFile = path.join(vmDir, 'meta.env');
  if (fs.existsSync(metaFile)) {
    for (const line of fs.readFileSync(metaFile, 'utf8').split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#') && t.includes('=')) {
        const i = t.indexOf('=');
        meta[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      }
    }
  }
  return meta;
}

function instanceComposePath(name) {
  return path.join(INSTANCES_DIR, name, 'docker-compose.yml');
}

const AGENT_BASE_IMAGES = {
  openclaw: 'ghcr.io/openclaw/openclaw:latest',
  picoclaw: 'sipeed/picoclaw:v0.2.5-launcher',
  hermes: 'nousresearch/hermes-agent:latest',
  nanobot: '',
};

let _baseVersionCache = { key: '', ts: 0, value: '' };
const BASE_VERSION_CACHE_TTL = 5 * 60 * 1000;

function parseOpenClawVersion(output) {
  const m = /OpenClaw\s+([\w.+-]+)/i.exec(output || '');
  const v = m ? m[1] : ((output || '').trim());
  // Strip a packaging build suffix (label is "2026.7.1-1", CLI says "2026.7.1")
  return v ? v.replace(/-\d+$/, '') : '';
}

/** Current OpenClaw version in a running container; falls back to reading it
 *  from the built image if the container is down. Returns '' when unknown. */
async function readOpenClawVersion(name, image) {
  try {
    const r = await runCmd('docker', ['exec', name, 'openclaw', '--version'], { timeout: 15000 });
    const v = parseOpenClawVersion(r.stdout);
    if (v) return v;
  } catch {}
  if (image) {
    try {
      const r = await runCmd('docker', ['run', '--rm', '--entrypoint', 'openclaw', image, '--version'], { timeout: 60000 });
      return parseOpenClawVersion(r.stdout);
    } catch {}
  }
  return '';
}

/** Version available in the latest base image for an agent type. Pulls the
 *  base tag (fast when unchanged) and reads its version label. Cached 5 min. */
async function readBaseImageVersion(agentType) {
  const base = AGENT_BASE_IMAGES[agentType];
  if (!base) return '';
  const now = Date.now();
  const key = 'base:' + base;
  if (_baseVersionCache.key === key && now - _baseVersionCache.ts < BASE_VERSION_CACHE_TTL) {
    return _baseVersionCache.value;
  }
  try { await runCmd('docker', ['pull', base], { timeout: 600000 }); } catch {}
  try {
    const r = await runCmd('docker', ['inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.version"}}', base], { timeout: 15000 });
    const v = parseOpenClawVersion(r.stdout);
    _baseVersionCache = { key, ts: now, value: v };
    return v;
  } catch {
    _baseVersionCache = { key, ts: now, value: '' };
    return '';
  }
}

/** { currentVersion, availableVersion, updateAvailable } for the update confirm. */
async function getUpdateInfo(name, agentType) {
  const meta = readMeta(path.join(INSTANCES_DIR, name));
  const agent = agentType || meta.AGENT || 'openclaw';
  const image = AGENT_IMAGES[agent] || AGENT_IMAGES.openclaw;
  const current = (await readOpenClawVersion(name, image)) || meta.OPENCLAW_VERSION || '';
  const available = await readBaseImageVersion(agent);
  const updateAvailable = !!(current && available && current !== available);
  return { currentVersion: current, availableVersion: available, updateAvailable };
}

function generateInstanceCompose(name, agent, password, port, opts = {}) {
  const { allowDocker = false, network = '' } = opts;
  const image = AGENT_IMAGES[agent] || AGENT_IMAGES.openclaw;
  const build = AGENT_BUILD_REL[agent] || AGENT_BUILD_REL.openclaw;
  const dataDir = containerDataDir(agent);

  let yaml = 'services:\n';
  yaml += `  ${name}:\n`;
  yaml += `    build:\n`;
  // Build context must be resolvable by the docker CLI, which runs INSIDE the
  // webui container → use WORKSPACE (the container's /workspace view).
  yaml += `      context: ${path.resolve(WORKSPACE, 'instances', name, build)}\n`;
  yaml += `    image: ${image}\n`;
  yaml += `    container_name: ${name}\n`;
  yaml += `    restart: unless-stopped\n`;
  if (port) yaml += `    ports:\n      - "${port}:22"\n`;
  // Volume sources are resolved by the Docker DAEMON → use HOST_WORKSPACE
  // (the daemon's host view, e.g. /www2/paddock).
  yaml += `    volumes:\n      - ${HOST_WORKSPACE}/instances/${name}/${agent}:${dataDir}\n`;
  if (allowDocker) yaml += `      - /var/run/docker.sock:/var/run/docker.sock\n`;
  if (network) yaml += `    network_mode: container:${network}\n`;
  yaml += `    environment:\n      TZ: Asia/Kolkata\n      ROOT_PASSWORD: ${password || ''}\n`;
  return yaml;
}

function writeInstanceCompose(name, agent, password, port, opts = {}) {
  const yaml = generateInstanceCompose(name, agent, password, port, opts);
  const composePath = instanceComposePath(name);
  fs.mkdirSync(path.dirname(composePath), { recursive: true });
  fs.writeFileSync(composePath, yaml);
}

/** Set or clear one KEY=VALUE line in an instance's meta.env (preserves the rest). */
function setMetaFlag(name, key, value) {
  const metaPath = path.join(INSTANCES_DIR, name, 'meta.env');
  let content = fs.existsSync(metaPath) ? fs.readFileSync(metaPath, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    content = content.replace(/\s*$/, '') + '\n' + line + '\n';
  }
  fs.writeFileSync(metaPath, content);
}

/** Apply settings (docker socket mount, network join) to an instance's compose
 *  file + meta.env. Compose files are machine-generated here, so regeneration
 *  is the source of truth. The route handles stop/start + validation around it. */
function applySettings(name, opts = {}) {
  const instDir = path.join(INSTANCES_DIR, name);
  const meta = readMeta(instDir);
  const agent = meta.AGENT || 'openclaw';
  const pw = meta.ROOT_PASSWORD || name.replace(PREFIX_RE, '');
  const port = meta.PORT || '';
  const allowDocker = !!opts.allowDocker;
  const network = opts.network || '';

  writeInstanceCompose(name, agent, pw, port, { allowDocker, network });
  setMetaFlag(name, 'DOCKER', allowDocker ? '1' : '0');
  setMetaFlag(name, 'NETWORK', network);

  return {
    allowDocker,
    network,
    image: AGENT_IMAGES[agent] || AGENT_IMAGES.openclaw,
    agent,
  };
}

/** Rebuild the image (--pull to redownload the base) and recreate the
 *  container. The recreate restarts it automatically when it's done.
 *  `buildArgs` are passed as `--build-arg K=V` (e.g. INSTALL_DOCKER=1).
 *  Set `pull: false` to skip redownloading the base image. */
async function updateAgent(name, { onLog = () => {}, onStep = () => {}, buildArgs = [], pull = true } = {}) {
  const composePath = instanceComposePath(name);
  const args = ['compose', '-f', composePath, 'build'];
  if (pull) args.push('--pull');
  for (const ba of buildArgs) args.push('--build-arg', ba);
  args.push(name);
  onStep('build', 'start');
  try {
    await runCmdStream('docker', args, { onLog, timeout: 900000 });
  } catch (e) {
    onStep('build', 'error');
    throw e;
  }
  onStep('build', 'end');

  onStep('recreate', 'start');
  try {
    await runCmdStream('docker', ['compose', '-f', composePath, 'up', '-d', '--no-deps', '--force-recreate', name], { onLog, timeout: 300000 });
  } catch (e) {
    onStep('recreate', 'error');
    throw e;
  }
  onStep('recreate', 'end');
}

function existingServices() {
  const names = new Set();
  if (!fs.existsSync(INSTANCES_DIR)) return names;
  for (const entry of fs.readdirSync(INSTANCES_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const composeFile = path.join(INSTANCES_DIR, entry.name, 'docker-compose.yml');
      if (fs.existsSync(composeFile)) names.add(entry.name);
    }
  }
  return names;
}

async function createVm(name, options = {}) {
  const {
    agent = 'openclaw', mode = 'fresh', cloneSource = '',
    sshEnabled = false, port = '', password = '',
    onLog = () => {}, onStep = () => {}, skipSetup = false,
  } = options;

  if (existingServices().has(name)) {
    throw new Error(`Agent '${name}' already exists`);
  }
  const instDir = path.join(INSTANCES_DIR, name);
  if (fs.existsSync(path.join(instDir, 'meta.env'))) {
    throw new Error(`Agent '${name}' already exists`);
  }

  const pw = password || name.replace(PREFIX_RE, '');
  let finalPort = '';
  if (sshEnabled) {
    if (port) {
      finalPort = port;
    } else {
      const used = new Set();
      if (fs.existsSync(INSTANCES_DIR)) {
        for (const entry of fs.readdirSync(INSTANCES_DIR, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const composeFile = path.join(INSTANCES_DIR, entry.name, 'docker-compose.yml');
          if (fs.existsSync(composeFile)) {
            for (const m of fs.readFileSync(composeFile, 'utf8').matchAll(/"(\d+):22"/g)) {
              used.add(parseInt(m[1]));
            }
          }
        }
      }
      let p = 43817;
      while (used.has(p)) p++;
      finalPort = String(p);
    }
  }

  const workspaceDir = path.join(instDir, agent);
  fs.mkdirSync(workspaceDir, { recursive: true });
  onLog('system', `Created instance directory: ${instDir}`);

  if (mode === 'clone') {
    const sources = fs.readdirSync(INSTANCES_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(n => n.startsWith(PREFIX + '-'))
      .sort().reverse();
    const src = cloneSource || sources[0] || '';
    if (!src) throw new Error('No source VM available to clone');
    const srcMeta = readMeta(path.join(INSTANCES_DIR, src));
    const srcAgent = srcMeta.AGENT || 'openclaw';
    const srcDir = path.join(INSTANCES_DIR, src, srcAgent);
    if (fs.existsSync(srcDir)) {
      onLog('system', `Cloning workspace from ${src}…`);
      for (const entry of fs.readdirSync(srcDir)) {
        const srcPath = path.join(srcDir, entry);
        const dstPath = path.join(workspaceDir, entry);
        if (fs.statSync(srcPath).isDirectory()) {
          fs.cpSync(srcPath, dstPath, { recursive: true });
        } else {
          fs.copyFileSync(srcPath, dstPath);
        }
      }
      onLog('system', `Cloned workspace from ${src}`);
    } else {
      throw new Error(`Source workspace for '${src}' not found`);
    }
  }

  let metaTxt = `ROOT_PASSWORD=${pw}\nAGENT=${agent}\n`;
  if (finalPort) metaTxt += `PORT=${finalPort}\n`;
  fs.writeFileSync(path.join(instDir, 'meta.env'), metaTxt);

  writeInstanceCompose(name, agent, pw, finalPort);

  const composePath = instanceComposePath(name);

  onStep('build', 'start');
  try {
    await runCmdStream('docker', ['compose', '-f', composePath, 'build'], { onLog, timeout: 900000 });
  } catch (e) {
    onStep('build', 'error');
    throw e;
  }
  onStep('build', 'end');

  onStep('up', 'start');
  try {
    await runCmdStream('docker', ['compose', '-f', composePath, 'up', '-d'], { onLog, timeout: 300000 });
  } catch (e) {
    onStep('up', 'error');
    throw e;
  }
  onStep('up', 'end');

  if ((agent === 'openclaw' || agent === 'picoclaw') && !skipSetup) {
    onStep('setup', 'start');
    let ready = false;
    for (let i = 0; i < 15; i++) {
      try {
        await runCmdStream('docker', ['exec', name, 'openclaw', 'setup', '--baseline'], { onLog, timeout: 60000 });
        ready = true;
        break;
      } catch {
        if (i === 14) break;
        onLog('system', `Container not ready yet (attempt ${i + 1}/15), waiting…`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (!ready) {
      onStep('setup', 'error');
      throw new Error(`Container '${name}' did not become ready for openclaw setup --baseline`);
    }
    onStep('setup', 'end');
  }

  if ((agent === 'openclaw' || agent === 'picoclaw') && !skipSetup) {
    await runCmdStream('docker', ['restart', name], { onLog, timeout: 30000 });
  }

  return name;
}

async function removeVm(name) {
  try { await runCmd('docker', ['rm', '-f', name], { timeout: 30000 }); } catch {}
  try { await runCmd('docker', ['network', 'rm', `${name}_default`], { timeout: 30000 }); } catch {}
  const instDir = path.join(INSTANCES_DIR, name);
  if (fs.existsSync(instDir)) fs.rmSync(instDir, { recursive: true, force: true });
}

async function resetVm(name) {
  const instDir = path.join(INSTANCES_DIR, name);
  const metaPath = path.join(instDir, 'meta.env');
  if (!fs.existsSync(metaPath)) throw new Error(`VM '${name}' does not exist`);
  const meta = readMeta(instDir);
  const agent = meta.AGENT || 'openclaw';

  try { await runCmd('docker', ['rm', '-f', name], { timeout: 30000 }); } catch {}
  const agentDir = path.join(instDir, agent);
  if (fs.existsSync(agentDir)) fs.rmSync(agentDir, { recursive: true, force: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const pw = meta.ROOT_PASSWORD || name.replace(PREFIX_RE, '');
  const port = meta.PORT || '';
  writeInstanceCompose(name, agent, pw, port);

  const composePath = instanceComposePath(name);
  await runCmd('docker', ['compose', '-f', composePath, 'up', '-d'], { timeout: 120000 });
}

function getComposePath(name) {
  return instanceComposePath(name);
}

async function startAgent(name) {
  const composePath = getComposePath(name);
  try {
    await runCmd('docker', ['start', name], { timeout: 30000 });
  } catch {
    await runCmd('docker', ['compose', '-f', composePath, 'up', '-d'], { timeout: 180000 });
  }
}

module.exports = {
  createVm, removeVm, resetVm, readMeta,
  generateInstanceCompose, writeInstanceCompose,
  applySettings, updateAgent, setMetaFlag,
  instanceComposePath, getComposePath,
  existingServices, startAgent,
  AGENT_IMAGES, AGENT_BUILD_REL,
  getUpdateInfo, readOpenClawVersion, readBaseImageVersion,
  INSTANCES_DIR, PREFIX, PREFIX_RE,
};
