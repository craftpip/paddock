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
 *  runs under plain `sh` (and falls back to an echoed read on non-TTY input).
 *
 *  The inner steps run in a subshell under `set -e` and the script ends with
 *  THEIR status. It used to end with `unset`, whose status is always 0, so a
 *  `mcp add` that failed was reported as wired — and the orchestrator kept a
 *  full-reach key for a PAD that never got it. `( exit N )` sets the status
 *  without closing the terminal the script was pasted into. */
function bootstrap(inner) {
  return [
    "printf 'Paddock API key: '",
    'stty -echo 2>/dev/null || true; IFS= read -r PADDOCK_MCP_TOKEN; stty echo 2>/dev/null || true',
    "printf '\\n'",
    'export PADDOCK_MCP_TOKEN',
    '( set -e',
    String(inner).trim(),
    ')',
    'paddock_mcp_rc=$?',
    'unset PADDOCK_MCP_TOKEN',
    '( exit $paddock_mcp_rc )',
  ].join('\n');
}

module.exports = { sq, bootstrap };
