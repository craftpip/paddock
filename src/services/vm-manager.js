const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
const COMPOSE_BASE = ['compose', '-p', 'vm-friends', '--project-directory', WORKSPACE];
const INSTANCES_DIR = path.join(WORKSPACE, 'instances');
const COMPOSE_FILE = path.join(WORKSPACE, 'docker-compose.yml');
const OVERRIDE_FILE = path.join(WORKSPACE, 'docker-compose.override.yml');

function runCmd(cmd, args, options = {}) {
  const { timeout = 120000 } = options;
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

const AGENT_IMAGES = {
  openclaw: 'vm-friends-vm-openclaw:latest',
  picoclaw: 'vm-friends-vm-picoclaw:latest',
  nanobot: 'vm-friends-vm-nanobot:latest',
  hermes: 'vm-friends-vm-hermes:latest',
};

const AGENT_BUILD = {
  openclaw: './vm_openclaw',
  picoclaw: './vm_picoclaw',
  nanobot: './vm_nanobot',
  hermes: './vm_hermes',
};

function containerDataDir(agent) {
  return agent === 'hermes' ? '/opt/data' : `/root/.${agent}`;
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

function generateOverrideYaml() {
  let yaml = 'services:\n';
  if (!fs.existsSync(INSTANCES_DIR)) return yaml;
  const dirs = fs.readdirSync(INSTANCES_DIR).filter(d => d.startsWith('vm-')).sort();
  for (const name of dirs) {
    const vmDir = path.join(INSTANCES_DIR, name);
    const metaFile = path.join(vmDir, 'meta.env');
    if (!fs.existsSync(metaFile)) continue;
    const meta = readMeta(vmDir);
    const agent = meta.AGENT || 'openclaw';
    const image = AGENT_IMAGES[agent] || AGENT_IMAGES.openclaw;
    const build = AGENT_BUILD[agent] || AGENT_BUILD.openclaw;
    yaml += `  ${name}:\n`;
    yaml += `    build:\n`;
    yaml += `      context: ${build}\n`;
    yaml += `    image: ${image}\n`;
    yaml += `    container_name: ${name}\n`;
    yaml += `    restart: unless-stopped\n`;
    if (meta.PORT) yaml += `    ports:\n      - "${meta.PORT}:22"\n`;
    yaml += `    volumes:\n      - ./instances/${name}/${agent}:${containerDataDir(agent)}\n`;
    yaml += `    environment:\n      TZ: Asia/Kolkata\n      ROOT_PASSWORD: ${meta.ROOT_PASSWORD || ''}\n`;
  }
  return yaml === 'services:\n' ? '' : yaml;
}

function writeOverride() {
  const yaml = generateOverrideYaml();
  if (yaml) {
    fs.writeFileSync(OVERRIDE_FILE, yaml);
  } else if (fs.existsSync(OVERRIDE_FILE)) {
    fs.unlinkSync(OVERRIDE_FILE);
  }
}

function existingServices() {
  const svcs = new Set();
  if (fs.existsSync(COMPOSE_FILE)) {
    for (const line of fs.readFileSync(COMPOSE_FILE, 'utf8').split('\n')) {
      const m = line.match(/^  ([a-zA-Z0-9_.-]+):$/);
      if (m) svcs.add(m[1]);
    }
  }
  return svcs;
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
    throw new Error(`Agent '${name}' already exists in compose files`);
  }
  if (fs.existsSync(path.join(INSTANCES_DIR, name, 'meta.env'))) {
    throw new Error(`Agent '${name}' already exists`);
  }

  const pw = password || name.replace(/^vm-/, '');
  let finalPort = '';
  if (sshEnabled) {
    if (port) {
      finalPort = port;
    } else {
      const used = new Set();
      if (fs.existsSync(OVERRIDE_FILE)) {
        for (const m of fs.readFileSync(OVERRIDE_FILE, 'utf8').matchAll(/"(\d+):22"/g)) {
          used.add(parseInt(m[1]));
        }
      }
      let p = 43817;
      while (used.has(p)) p++;
      finalPort = String(p);
    }
  }

  const instDir = path.join(INSTANCES_DIR, name);
  const workspaceDir = path.join(instDir, agent);
  fs.mkdirSync(workspaceDir, { recursive: true });

  if (mode === 'clone') {
    const sources = fs.readdirSync(INSTANCES_DIR).filter(d => d.startsWith('vm-')).sort().reverse();
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

  writeOverride();
  await runCmd('docker', [...COMPOSE_BASE, 'up', '-d', name], { timeout: 180000 });

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
  writeOverride();
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
  writeOverride();
  await runCmd('docker', [...COMPOSE_BASE, 'up', '-d', name], { timeout: 120000 });
}

module.exports = { createVm, removeVm, resetVm, generateOverrideYaml, writeOverride, readMeta };