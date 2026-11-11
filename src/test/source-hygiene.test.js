// Static checks for defects that build, pass `node --check`, and only show up
// when the line runs or the page renders. Each one is a lesson from AGENTS.md
// turned into a test (plan 118 Phase 6).
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const SRC = path.join(__dirname, '..');
const requireClient = createRequire(path.join(SRC, 'client', 'package.json'));

function walk(dir, keep, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'public', 'client', 'data', 'test', 'vm-builds'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, keep, out);
    else if (keep(entry.name)) out.push(full);
  }
  return out;
}

// A name that is used but never declared, imported or handed in is a
// ReferenceError the first time its line runs. Resolving every identifier to a
// binding finds it without running anything.
it('no backend file refers to a name it never declares', () => {
  const parser = requireClient('@babel/parser');
  const traverse = requireClient('@babel/traverse').default;
  const known = new Set([...Object.getOwnPropertyNames(globalThis), 'require', 'module', 'exports', '__dirname', '__filename']);
  const files = walk(SRC, (name) => name.endsWith('.js'));
  assert.ok(files.length > 60, `walked ${files.length} backend files`);
  const unbound = [];
  for (const file of files) {
    const ast = parser.parse(fs.readFileSync(file, 'utf8'), { sourceType: 'script', allowReturnOutsideFunction: true });
    traverse(ast, {
      Identifier(p) {
        if (!p.isReferencedIdentifier()) return;
        if (!p.scope.hasBinding(p.node.name) && !known.has(p.node.name)) unbound.push(`${path.relative(SRC, file)}:${p.node.loc.start.line} ${p.node.name}`);
      },
    });
  }
  assert.deepEqual(unbound, []);
});

// The installed MCP SDK does not catch a throwing tool handler: the rejection
// escapes and kills the webui. Every tool must go through the registerTool
// wrapper in mcp.js, which turns a throw into a tool error.
it('every MCP tool is registered through the wrapper that catches its errors', () => {
  const direct = [];
  for (const file of walk(SRC, (name) => name.endsWith('.js'))) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/\bserver\.(registerTool|tool)\(/.test(line)) direct.push(`${path.relative(SRC, file)}:${i + 1}`);
    });
  }
  assert.equal(direct.length, 1, `exactly one direct SDK registration (the wrapper itself): ${direct.join(', ')}`);
  const mcp = fs.readFileSync(path.join(SRC, 'mcp.js'), 'utf8');
  const wrapper = mcp.slice(mcp.indexOf('function registerTool('), mcp.indexOf('function registerTools('));
  assert.match(wrapper, /server\.registerTool\(/, 'the one direct call is inside the wrapper');
  assert.match(wrapper, /catch \(err\)/, 'and the wrapper catches');
});

// Tailwind v4 emits a colour utility only for a `--color-*` token in @theme.
// `bg-ok` or `text-warn` builds without an error, produces no rule, and the
// element silently falls back to an inherited colour. So every colour-shaped
// class in the client must name a real token or a utility that is not a colour.
it('every colour utility in the client names a token that exists', () => {
  const css = fs.readFileSync(path.join(SRC, 'client', 'src', 'index.css'), 'utf8');
  const colors = new Set([...css.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const shadows = new Set([...css.matchAll(/--shadow-([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  assert.ok(colors.size > 30, 'read the palette');
  ['transparent', 'current', 'inherit', 'white', 'black'].forEach((c) => colors.add(c));
  // Utilities that share a colour prefix but are not colours.
  const NOT_COLOR = {
    text: /^(xs|sm|base|lg|xl|[2-9]xl|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/,
    bg: /^(none|cover|contain|auto|fixed|local|scroll|center|top|bottom|left|right|repeat|no-repeat|repeat-x|repeat-y|clip-.+|origin-.+|gradient-.+|linear-.+|radial.*|conic.*|blend-.+)$/,
    border: /^(\d+|[trblxyse]|[trblxyse]-\d+|solid|dashed|dotted|double|hidden|none|collapse|separate|spacing-.+)$/,
    divide: /^([xy]|[xy]-\d+|[xy]-reverse|solid|dashed|dotted|double|none)$/,
    ring: /^(\d+|inset|offset-\d+)$/,
    outline: /^(\d+|none|hidden|solid|dashed|dotted|double|offset-\d+)$/,
    fill: /^(none)$/,
    stroke: /^(\d+|none)$/,
    shadow: /^(none|inner|xs|sm|md|lg|xl|2xl)$/,
  };
  const SIDE = /^([trblxyse])-(.+)$/;
  const classRe = /(?<![\w-])(?:[a-z-]+:)*(text|bg|border|divide|ring|outline|fill|stroke|shadow)-([a-z][a-z0-9-]*)(?:\/\d+)?(?![\w-])/g;
  const bad = new Set();
  let seen = 0;
  const files = [];
  const collect = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (/\.jsx?$/.test(entry.name)) files.push(full);
    }
  };
  collect(path.join(SRC, 'client', 'src'));
  for (const file of files) {
    // Only string literals can carry class names; prose in comments cannot.
    const strings = fs.readFileSync(file, 'utf8').match(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g) || [];
    for (const str of strings) {
      for (const m of str.matchAll(classRe)) {
        const [, prefix, rest] = m;
        seen += 1;
        if (NOT_COLOR[prefix]?.test(rest)) continue;
        if (prefix === 'shadow' && shadows.has(rest)) continue;
        if (colors.has(rest)) continue;
        const side = prefix === 'border' && rest.match(SIDE);
        if (side && (colors.has(side[2]) || NOT_COLOR.border.test(side[2]))) continue;
        bad.add(`${m[0]}  (${path.relative(path.join(SRC, 'client', 'src'), file)})`);
      }
    }
  }
  assert.ok(seen > 500, `the scan found class names (${seen})`);
  assert.deepEqual([...bad], [], 'each of these builds to NO css rule: use a token from index.css @theme');
});
