const { spawn } = require('child_process');

/**
 * Stream a command's stdout/stderr through a callback.
 * Same contract as runCmd() but emits chunks as they arrive instead of
 * buffering everything until exit. Used for long-running operations whose
 * output should be shown live (docker compose build, openclaw setup, ...).
 */
function runCmdStream(cmd, args, options = {}) {
  const { timeout = 900000, onLog } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args || [], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeout);

    const handle = (stream) => {
      stream.on('data', (d) => {
        const s = d.toString();
        if (stream === child.stderr) stderr += s;
        else stdout += s;
        if (onLog) {
          try { onLog(stream === child.stderr ? 'stderr' : 'stdout', s); } catch {}
        }
      });
    };
    if (child.stdout) handle(child.stdout);
    if (child.stderr) handle(child.stderr);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeout}ms: ${cmd} ${(args || []).join(' ')}`));
      } else if (code !== 0) {
        reject(new Error(`Command exited with code ${code}: ${cmd} ${(args || []).join(' ')}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

module.exports = { runCmdStream };
