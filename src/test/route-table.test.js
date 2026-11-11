// Plan 118 Phase 5: the routes moved out of app.js into routes/<area>.js.
// app.js cannot be loaded in a test (requiring it boots the server), so the
// table is read from source by following the registrations in order.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { routeTable, overlap } = require('./helpers/route-table');

const SRC = path.join(__dirname, '..');
const baseline = require('./fixtures/route-table.json');
const table = routeTable(path.join(SRC, 'app.js'));
const key = (r) => `${r.method.toUpperCase()} ${r.path}`;

it('serves exactly the routes it served as one file', () => {
  assert.equal(new Set(table.map(key)).size, table.length, 'no route is registered twice');
  assert.deepEqual(table.map(key).sort(), [...baseline].sort());
});

it('keeps the relative order of every pair of routes one request could match', () => {
  const now = new Map(table.map((r, i) => [key(r), i]));
  const rows = baseline.map((s) => ({ method: s.split(' ')[0].toLowerCase(), path: s.slice(s.indexOf(' ') + 1), key: s }));
  let pairs = 0;
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      if (!overlap(rows[i], rows[j])) continue;
      pairs += 1;
      assert.ok(now.get(rows[i].key) < now.get(rows[j].key), `${rows[i].key} must stay ahead of ${rows[j].key}`);
    }
  }
  // The SPA catch-all overlaps every GET; if this is 0 the predicate is inert.
  assert.ok(pairs > 50, `checked ${pairs} overlapping pairs`);
  assert.equal(key(table.at(-1)), 'GET *', 'the page catch-all is registered last');
});

it('keeps API routes out of app.js and each route file to a readable size', () => {
  const inApp = table.filter((r) => r.file === 'app.js').map(key);
  assert.deepEqual(inApp, ['GET *'], 'only the page catch-all is declared in app.js');
  const dir = path.join(SRC, 'routes');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').length;
    assert.ok(lines <= 700, `routes/${file} is ${lines} lines; split the area before adding more`);
  }
  assert.ok(fs.readFileSync(path.join(SRC, 'app.js'), 'utf8').split('\n').length <= 1300, 'app.js stays small');
});

// A handler that uses a helper app.js did not hand over parses, passes
// `node --check`, and throws only when that route is called.
it('no route file or app.js refers to a name it neither declares nor is handed', () => {
  const requireClient = createRequire(path.join(SRC, 'client', 'package.json'));
  const parser = requireClient('@babel/parser');
  const traverse = requireClient('@babel/traverse').default;
  const known = new Set([...Object.getOwnPropertyNames(globalThis), 'require', 'module', 'exports', '__dirname', '__filename']);
  const files = ['app.js', ...fs.readdirSync(path.join(SRC, 'routes')).filter((f) => f.endsWith('.js')).map((f) => `routes/${f}`)];
  const unbound = [];
  let references = 0;
  for (const file of files) {
    const ast = parser.parse(fs.readFileSync(path.join(SRC, file), 'utf8'), { sourceType: 'script' });
    traverse(ast, {
      Identifier(p) {
        if (!p.isReferencedIdentifier()) return;
        references += 1;
        if (!p.scope.hasBinding(p.node.name) && !known.has(p.node.name)) unbound.push(`${file}:${p.node.loc.start.line} ${p.node.name}`);
      },
    });
  }
  assert.ok(references > 2000, `the scan walked the files (${references} references)`);
  assert.deepEqual(unbound, []);
});

it('hands every route file exactly the helpers it destructures from ctx', () => {
  const app = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  for (const m of app.matchAll(/require\('\.\/routes\/([\w-]+)'\)\(app, \{([^}]*)\}\);/g)) {
    const given = m[2].split(',').map((s) => s.trim()).filter(Boolean).sort();
    const src = fs.readFileSync(path.join(SRC, 'routes', `${m[1]}.js`), 'utf8');
    const taken = (src.match(/const \{([^}]*)\} = ctx;/)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean).sort();
    assert.deepEqual(given, taken, `routes/${m[1]}.js`);
  }
});
