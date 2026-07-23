const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
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

function generateInstanceCompose(name, agent, password, port) {
  const image = AGENT_IMAGES[agent] || AGENT_IMAGES.openclaw;
  const build = AGENT_BUILD_REL[agent] || AGENT_BUILD_REL.openclaw;
  const dataDir = containerDataDir(agent);

  let yaml = 'services:\n';
  yaml += `  ${name}:\n`;
  yaml += `    build:\n`;
  yaml += `      context: ${build}\n`;
  yaml += `    image: ${image}\n`;
  yaml += `    container_name: ${name}\n`;
  yaml += `    restart: unless-stopped\n`;
  if (port) yaml += `    ports:\n      - "${port}:22"\n`;
  yaml += `    volumes:\n      - ./${agent}:${dataDir}\n`;
  yaml += `    environment:\n      TZ: Asia/Kolkata\n      ROOT_PASSWORD: ${password || ''}\n`;
  return yaml;
}

function writeInstanceCompose(name, agent, password, port) {
  const yaml = generateInstanceCompose(name, agent, password, port);
  const composePath = instanceComposePath(name);
  fs.mkdirSync(path.dirname(composePath), { recursive: true });
  fs.writeFileSync(composePath, yaml);
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

function applyDefaultConfig(configPath, agent, botToken, allowFrom) {
  let data = {};
  if (fs.existsSync(configPath)) {
    try { data = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
  }
  if (typeof data !== 'object' || Array.isArray(data)) data = {};

  const baseUrl = (process.env.DEFAULT_MODEL_BASE_URL || 'http://10.69.1.131:11434/v1').replace(/\/v1$/, '');
  const model = process.env.DEFAULT_MODEL_NAME || 'gpt-oss:20b-73728';
  const ctx = parseInt(process.env.DEFAULT_CONTEXT_LENGTH || '96000', 10);

  const channel = { enabled: true, allowFrom: [allowFrom] };
  const ollamaCfg = { baseUrl, apiKey: 'ollama', api: 'ollama', models: [{ id: model, name: model, reasoning: false, input: ['text'], contextWindow: ctx, maxTokens: ctx * 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] };

  if (agent === 'openclaw') {
    channel.botToken = botToken;
    channel.dmPolicy = 'allowlist';
    data.channels = { telegram: channel };
    data.agents = { defaults: { model: { primary: `ollama/${model}` } } };
    data.models = { providers: { ollama: ollamaCfg } };
  } else {
    channel.token = botToken;
    data.channels = { telegram: channel };
    const agentCfg = { model, provider: 'openai', contextLength: ctx };
    const provCfg = { apiBase: baseUrl, apiKey: 'ollama' };
    if (agent === 'picoclaw') {
      data.model_list = [{ model_name: model, model: `ollama/${model}`, api_base: baseUrl }];
      agentCfg.model_name = model;
      data.model = model;
      data.model_context_length = ctx;
    }
    data.agents = { defaults: agentCfg };
    data.providers = { openai: provCfg };
  }

  fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n');
}

async function createVm(name, options = {}) {
  const {
    agent = 'openclaw', mode = 'fresh', cloneSource = '',
    sshEnabled = false, port = '', password = '',
    botToken = '', allowFrom = '532156945', defaultConfig = false,
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
      for (const entry of fs.readdirSync(srcDir)) {
        const srcPath = path.join(srcDir, entry);
        const dstPath = path.join(workspaceDir, entry);
        if (fs.statSync(srcPath).isDirectory()) {
          fs.cpSync(srcPath, dstPath, { recursive: true });
        } else {
          fs.copyFileSync(srcPath, dstPath);
        }
      }
    } else {
      throw new Error(`Source workspace for '${src}' not found`);
    }
  }

  let metaTxt = `ROOT_PASSWORD=${pw}\nAGENT=${agent}\n`;
  if (finalPort) metaTxt += `PORT=${finalPort}\n`;
  fs.writeFileSync(path.join(instDir, 'meta.env'), metaTxt);

  writeInstanceCompose(name, agent, pw, finalPort);

  const composePath = instanceComposePath(name);
  await runCmd('docker', ['compose', '-f', composePath, 'up', '-d'], { timeout: 180000 });

  if (defaultConfig) {
    if (agent === 'hermes') return name;
    if (!botToken) throw new Error('Bot token required for default config');

    try {
      await runCmd('docker', ['exec', name, 'sh', '-lc',
        'openclaw onboard --non-interactive --accept-risk --mode local --flow manual --auth-choice skip --skip-channels --skip-skills --skip-search --skip-ui --skip-health --no-install-daemon >/tmp/onboard.log 2>&1 || true'
      ], { timeout: 30000 });
    } catch {}

    const configPath = path.join(workspaceDir, 'openclaw.json');
    for (let i = 0; i < 60; i++) {
      if (fs.existsSync(configPath)) break;
      await new Promise(r => setTimeout(r, 1000));
    }

    if (fs.existsSync(configPath)) {
      applyDefaultConfig(configPath, agent, botToken, allowFrom);
      try { fs.chmodSync(configPath, 0o600); } catch {}
      try { await runCmd('docker', ['restart', name]); } catch {}
    }
  }

  return name;
}

async function removeVm(name) {
  try { await runCmd('docker', ['rm', '-f', name], { timeout: 30000 }); } catch {}
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
  instanceComposePath, getComposePath,
  existingServices, startAgent,
  INSTANCES_DIR, PREFIX, PREFIX_RE,
};
