/** Shared helpers for the driver `mcp` objects (plan 35b). The builders return
 *  fully shell-quoted command strings that CommandsPane pastes into the docked
 *  terminal; callers never concatenate URL/name/token text themselves. */

/** Shell-quote a value so it survives the shell in the terminal. Multi-line
 *  values (patch scripts) are preserved inside the single-quoted string. */
function sq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** Wrap a driver's add command in the human key bootstrap: the Paddock API key
 *  is typed at a silent terminal prompt (never pasted, historted, logged, or
 *  held in frontend state), exported for the child command, then unset.
 *  POSIX-safe: uses `stty -echo` instead of bash-only `read -rsp`, so it also
 *  runs under plain `sh` (and falls back to an echoed read on non-TTY input). */
function bootstrap(inner) {
  return [
    "printf 'Paddock API key: '",
    'stty -echo 2>/dev/null || true; IFS= read -r PADDOCK_MCP_TOKEN; stty echo 2>/dev/null || true',
    "printf '\\n'",
    'export PADDOCK_MCP_TOKEN',
    String(inner).trim(),
    'unset PADDOCK_MCP_TOKEN',
  ].join('\n');
}

module.exports = { sq, bootstrap };
