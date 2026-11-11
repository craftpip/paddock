// The MCP tools moved from one 1880-line function in mcp.js into
// mcp/tools-<area>.js (plan 118 follow-up). This pins that the surface a
// client sees is the same list in the same order, in both modes.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SRC = path.join(__dirname, '..');
const all = require('./fixtures/mcp-tools-all.json');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tools-'));

// The task-queue flag is read when the tools register, so each mode gets its
// own process.
function registered(flag) {
  const env = { ...process.env, PAD_DB_PATH: path.join(root, `tools-${flag || 'off'}.db`) };
  delete env.PADDOCK_TASK_QUEUE;
  if (flag) env.PADDOCK_TASK_QUEUE = flag;
  const script = `const names=[];require(${JSON.stringify(path.join(SRC, 'mcp.js'))}).registerTools({registerTool:(n)=>names.push(n)});process.stdout.write(JSON.stringify(names));`;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' }).trim().split('\n').at(-1));
}

it('registers the same tools in the same order with the task queue on', () => {
  assert.deepEqual(registered('1'), all);
});

it('hides exactly the task tools with the task queue off', () => {
  const off = registered('');
  const hidden = all.filter((name) => !off.includes(name));
  assert.ok(hidden.length > 0 && hidden.every((name) => name.startsWith('task_')), `hidden: ${hidden.join(', ')}`);
  assert.deepEqual(off, all.filter((name) => !name.startsWith('task_')));
});

it('hands every tool file exactly the helpers it destructures from ctx', () => {
  const mcp = fs.readFileSync(path.join(SRC, 'mcp.js'), 'utf8');
  const calls = [...mcp.matchAll(/require\('\.\/mcp\/([\w-]+)'\)\(registerToolBound, \{([^}]*)\}\);/g)];
  assert.equal(calls.length, fs.readdirSync(path.join(SRC, 'mcp')).filter((f) => f.endsWith('.js')).length, 'every tool file is registered');
  for (const m of calls) {
    const given = m[2].split(',').map((s) => s.trim()).filter(Boolean).sort();
    const src = fs.readFileSync(path.join(SRC, 'mcp', `${m[1]}.js`), 'utf8');
    const taken = (src.match(/const \{([^}]*)\} = ctx;/)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean).sort();
    assert.deepEqual(given, taken, `mcp/${m[1]}.js`);
    assert.ok(src.split('\n').length <= 700, `mcp/${m[1]}.js stays a readable size`);
  }
  assert.ok(mcp.split('\n').length <= 1300, 'mcp.js stays small');
});
