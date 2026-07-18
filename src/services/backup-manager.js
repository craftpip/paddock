const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
const COMPOSE_PREFIX = ['compose', '-p', 'vm-friends', '--project-directory', WORKSPACE];
const BACKUPS_DIR = path.join(WORKSPACE, 'backups');

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

  return destFile;
}

async function restoreAgent(agentName) {
  const files = fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.startsWith(agentName + '_') && f.endsWith('.tar.gz'))
    .sort()
    .reverse();

  if (files.length === 0) throw new Error(`No backup found for '${agentName}'`);

  const latest = path.join(BACKUPS_DIR, files[0]);
  await runCmd('docker', ['cp', latest, `${agentName}:/tmp/restore.tar.gz`], { timeout: 60000 });
  await runCmd('docker', ['exec', agentName, 'tar', '-xzf', '/tmp/restore.tar.gz', '-C', '/root/.openclaw'], { timeout: 60000 });
  try { await runCmd('docker', ['exec', agentName, 'rm', '/tmp/restore.tar.gz'], { timeout: 10000 }); } catch {}
  await runCmd('docker', [...COMPOSE_PREFIX, 'restart', agentName], { timeout: 60000 });
}

module.exports = { backupAgent, restoreAgent };