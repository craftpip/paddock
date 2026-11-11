#!/usr/bin/env node
// Runs every test file in its own process and reports one table.
//
//   node test/run-all.mjs                 every *.test.js
//   node test/run-all.mjs mission queue   only files whose name contains a word
//   TEST_TIMEOUT_MS=300000 node test/run-all.mjs
//
// One process per file because the suites set process-wide state before they
// load the app (PAD_DB_PATH, WORKSPACE_ROOT) and several replace module
// functions; `node --test test/` in one go shares none of that safely and used
// to hang. A file that does not exit inside the timeout is killed and reported
// as HUNG, which is a failure: a suite that leaks a handle is a broken suite.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const timeoutMs = Number(process.env.TEST_TIMEOUT_MS || 240000);
const words = process.argv.slice(2);

// Some suites assert the DEFAULT surface, so flags the running container sets
// for the live app must not leak into them.
const UNSET = {
  'mcp.test.js': ['PADDOCK_TASK_QUEUE'],
  'vm-manager.test.js': Object.keys(process.env).filter((k) => k.startsWith('GUARD_')),
};

const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => !words.length || words.some((w) => f.includes(w)))
  .sort();

function runFile(file) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const key of UNSET[file] || []) delete env[key];
    const started = Date.now();
    const child = spawn(process.execPath, ['--test', join(here, file)], { cwd: join(here, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let hung = false;
    const timer = setTimeout(() => { hung = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const count = (label) => Number((out.match(new RegExp(`^# ${label} (\\d+)`, 'm')) || [])[1] || 0);
      const failed = [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
      resolve({ file, code, hung, pass: count('pass'), fail: count('fail'), failed, seconds: (Date.now() - started) / 1000, out });
    });
  });
}

const results = [];
for (const file of files) {
  const r = await runFile(file);
  results.push(r);
  const status = r.hung ? 'HUNG' : r.code === 0 ? 'ok  ' : 'FAIL';
  console.log(`${status} ${file.padEnd(44)} ${String(r.pass).padStart(4)} pass ${String(r.fail).padStart(3)} fail ${r.seconds.toFixed(1).padStart(6)}s`);
  for (const name of r.failed) console.log(`       ✗ ${name}`);
  if (r.hung) console.log(`       did not exit within ${timeoutMs / 1000}s (a leaked timer, socket or database handle)`);
}

const bad = results.filter((r) => r.hung || r.code !== 0);
const total = results.reduce((a, r) => a + r.pass, 0);
console.log(`\n${results.length} files, ${total} tests passed, ${bad.length} file(s) failing${bad.length ? ': ' + bad.map((r) => r.file).join(', ') : ''}`);
if (process.env.TEST_VERBOSE) for (const r of bad) console.log(`\n===== ${r.file} =====\n${r.out.slice(-4000)}`);
process.exit(bad.length ? 1 : 0);
