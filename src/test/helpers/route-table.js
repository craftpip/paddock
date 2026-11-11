// Reads the ordered route table out of app.js WITHOUT loading it (requiring
// app.js boots the server). It follows `require('./routes/<area>')(app, …)`
// registrations into the area files, so the result is the order Express will
// see. Used by route-table.test.js.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'];

function routeTable(appFile) {
  const requireClient = createRequire(path.join(__dirname, '..', '..', 'client', 'package.json'));
  const parser = requireClient('@babel/parser');
  const traverse = requireClient('@babel/traverse').default;
  const out = [];
  const visit = (file, top) => {
    const ast = parser.parse(fs.readFileSync(file, 'utf8'), { sourceType: 'script' });
    traverse(ast, {
      CallExpression(p) {
        const { callee, arguments: args } = p.node;
        // app.<method>('<path>', …)
        if (callee.type === 'MemberExpression' && callee.object.name === 'app' && METHODS.includes(callee.property.name)) {
          const first = args[0];
          out.push({
            method: callee.property.name,
            path: first?.type === 'StringLiteral' ? first.value : `<${first?.type || 'none'}>`,
            file: path.basename(file),
          });
          return;
        }
        // require('./routes/x')(app, …) — only followed from app.js itself
        if (top && callee.type === 'CallExpression' && callee.callee.name === 'require'
            && /^\.\/routes\//.test(callee.arguments[0]?.value || '')) {
          visit(path.join(path.dirname(file), `${callee.arguments[0].value}.js`), false);
        }
      },
    });
  };
  visit(appFile, true);
  return out;
}

/** Can one request match both patterns? Then their relative order is behaviour. */
function overlap(a, b) {
  if (a.method !== b.method && a.method !== 'all' && b.method !== 'all') return false;
  const wild = (p) => !p.startsWith('/') || /[*(]/.test(p);
  if (wild(a.path) || wild(b.path)) return true;
  const x = a.path.split('/');
  const y = b.path.split('/');
  if (x.length !== y.length) return false;
  return x.every((seg, i) => seg === y[i] || seg.startsWith(':') || y[i].startsWith(':'));
}

module.exports = { routeTable, overlap };
