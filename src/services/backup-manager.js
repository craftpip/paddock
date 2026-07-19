const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
const INSTANCES_DIR = path.join(WORKSPACE, 'instances');
const COMPOSE_PREFIX = ['compose', '-p', 'vm-friends', '--project-directory', WORKSPACE];
const BACKUPS_DIR = path.join(WORKSPACE, 'backups');
const META_FILE = path.join(BACKUPS_DIR, 'backup-meta.json');

function loadMeta() {
  try {
    if (fs.existsSync(META_FILE)) return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveMeta(meta) {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

function detectAgentType(agentName) {
  const metaFile = path.join(INSTANCES_DIR, agentName, 'meta.env');
  if (fs.existsSync(metaFile)) {
    const content = fs.readFileSync(metaFile, 'utf8');
    const match = content.match(/^AGENT=(.+)$/m);
    if (match) return match[1].trim();
  }
  return 'openclaw';
}

function getBackupType(backupFile) {
  const meta = loadMeta();
  if (meta[backupFile]) return meta[backupFile].type;
  const vmName = backupFile.split('_')[0];
  return detectAgentType(vmName);
}

function runCmd(cmd, args, options = {}) {
  const { timeout = 120000, input } = options;
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
}

async function backupAgent(agentName) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const ts = timestamp();
  const tmpFile = `/tmp/${agentName}_${ts}.tar.gz`;
  const destFile = path.join(BACKUPS_DIR, `${agentName}_${ts}.tar.gz`);

  await runCmd('docker', ['exec', agentName, 'openclaw', 'backup', 'create', '--output', tmpFile], { timeout: 180000 });
  await runCmd('docker', ['cp', `${agentName}:${tmpFile}`, BACKUPS_DIR + '/'], { timeout: 60000 });

  const srcName = `${agentName}_${ts}.tar.gz`;
  const tempPath = path.join(BACKUPS_DIR, srcName);

  // docker cp saves to the name from the source, rename if needed
  if (fs.existsSync(tempPath) && tempPath !== destFile) {
    fs.renameSync(tempPath, destFile);
  }

  try { await runCmd('docker', ['exec', agentName, 'rm', tmpFile], { timeout: 10000 }); } catch {}

  const type = detectAgentType(agentName);
  const meta = loadMeta();
  meta[`${agentName}_${ts}.tar.gz`] = { type, agent: agentName, created: new Date().toISOString() };
  saveMeta(meta);

  return destFile;
}

async function restoreAgent(agentName, backupFile) {
  let restorePath;
  if (backupFile) {
    restorePath = path.join(BACKUPS_DIR, backupFile);
    if (!fs.existsSync(restorePath)) throw new Error(`Backup file not found: ${backupFile}`);
  } else {
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.startsWith(agentName + '_') && f.endsWith('.tar.gz'))
      .sort()
      .reverse();
    if (files.length === 0) throw new Error(`No backup found for '${agentName}'`);
    restorePath = path.join(BACKUPS_DIR, files[0]);
  }

  const backupType = getBackupType(path.basename(restorePath));
  const containerType = detectAgentType(agentName);
  if (backupType !== containerType) {
    throw new Error(`Type mismatch: backup is ${backupType} but container is ${containerType}`);
  }

  await runCmd('docker', ['cp', restorePath, `${agentName}:/tmp/restore.tar.gz`], { timeout: 60000 });
  await runCmd('docker', ['exec', agentName, 'tar', '-xzf', '/tmp/restore.tar.gz', '-C', '/root/.openclaw'], { timeout: 60000 });
  try { await runCmd('docker', ['exec', agentName, 'rm', '/tmp/restore.tar.gz'], { timeout: 10000 }); } catch {}
  await runCmd('docker', [...COMPOSE_PREFIX, 'restart', agentName], { timeout: 60000 });
}

module.exports = { backupAgent, restoreAgent, getBackupType, loadMeta };