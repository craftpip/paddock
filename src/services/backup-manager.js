const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { runCmdStream } = require('./cmd');
const { getDriver, listDrivers } = require('./drivers');

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
const INSTANCES_DIR = path.join(WORKSPACE, 'instances');
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

function runCmd(cmd, args, options = {}) {
  const { timeout = 120000 } = options;
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function readMeta(agentName) {
  const meta = {};
  const metaFile = path.join(INSTANCES_DIR, agentName, 'meta.env');
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

function getBackupType(filename) {
  if (listDrivers().some((d) => d.backupTypeMarker && filename.includes(d.backupTypeMarker))) return 'cli';
  return 'legacy';
}

async function backupAgent(agentName) {
  const meta = readMeta(agentName);
  const agent = meta.AGENT || 'openclaw';
  const dataDir = getDriver(agent).dataDir;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const archive = `${agentName}_${ts}.tar.gz`;

  try {
    await runCmd('docker', ['exec', agentName, 'tar', '-czf', `/tmp/${archive}`, '-C', dataDir, '.'], { timeout: 120000 });
    await runCmd('docker', ['cp', `${agentName}:/tmp/${archive}`, path.join(BACKUPS_DIR, archive)], { timeout: 30000 });
    await runCmd('docker', ['exec', agentName, 'rm', `/tmp/${archive}`], { timeout: 10000 });

    const metaData = loadMeta();
    metaData[archive] = { agent: agentName, type: getBackupType(archive), created: ts, agentType: agent };
    saveMeta(metaData);

    return archive;
  } catch (err) {
    throw new Error(`Backup failed for ${agentName}: ${err.message}`);
  }
}

async function restoreAgent(agentName, archiveFile, onLog = () => {}) {
  const instDir = path.join(INSTANCES_DIR, agentName);
  const meta = readMeta(agentName);
  const agent = meta.AGENT || 'openclaw';
  const dataDir = getDriver(agent).dataDir;
  const archivePath = path.join(BACKUPS_DIR, archiveFile);

  if (!fs.existsSync(archivePath)) throw new Error(`Backup file not found: ${archiveFile}`);

  try {
    onLog('system', `Copying ${archiveFile} into ${agentName}…`);
    await runCmdStream('docker', ['cp', archivePath, `${agentName}:/tmp/${archiveFile}`], { onLog, timeout: 60000 });
    onLog('system', `Extracting ${archiveFile} to ${dataDir}…`);
    await runCmdStream('docker', ['exec', agentName, 'tar', '-xzf', `/tmp/${archiveFile}`, '-C', dataDir], { onLog, timeout: 180000 });
    await runCmdStream('docker', ['exec', agentName, 'rm', `/tmp/${archiveFile}`], { onLog, timeout: 10000 });
    onLog('system', 'Restarting container…');
    await runCmdStream('docker', ['restart', agentName], { onLog, timeout: 60000 });
    onLog('system', `Restore complete: ${archiveFile}`);
    return true;
  } catch (err) {
    throw new Error(`Restore failed for ${agentName}: ${err.message}`);
  }
}

module.exports = { backupAgent, restoreAgent, getBackupType, loadMeta, saveMeta };
