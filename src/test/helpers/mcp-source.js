// The MCP surface's source as one string: mcp.js followed by every tool module
// in mcp/. Tests that pin wiring by reading source (a resolved name reaching
// the action, an argument passed to docker) were written against one file;
// the tools moved to mcp/tools-*.js in plan 118's follow-up, and each tool is
// still one `registerToolBound(` call, so slicing "to the next registration"
// works on the joined text exactly as before.
const fs = require('node:fs');
const path = require('node:path');

module.exports = function mcpSource() {
  const src = path.join(__dirname, '..', '..');
  const dir = path.join(src, 'mcp');
  const parts = [fs.readFileSync(path.join(src, 'mcp.js'), 'utf8')];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) parts.push(fs.readFileSync(path.join(dir, file), 'utf8'));
  return parts.join('\n');
};
