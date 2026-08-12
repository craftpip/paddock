/** The internal Paddock MCP endpoint — the URL an agent container uses to reach
 *  Paddock's own MCP server (plan 35b). Computed from the configured host
 *  (`HOST_NAME`/`HOST_PROTO` in .env) plus the webui port, never hardcoded.
 *  `PADDOCK_MCP_URL` overrides the whole thing when set. */

function getPaddockMcpUrl() {
  if (process.env.PADDOCK_MCP_URL) return process.env.PADDOCK_MCP_URL;
  const proto = process.env.HOST_PROTO || 'http';
  const host = process.env.HOST_NAME || 'localhost';
  const port = process.env.WEBUI_PORT || '6789';
  return `${proto}://${host}:${port}/mcp`;
}

module.exports = { getPaddockMcpUrl };
