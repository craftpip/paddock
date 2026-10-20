const HELP = `Usage:
  paddock pad list [--json]
  paddock pad status <pad> [--json]
  paddock pad start <pad> [--json]
  paddock pad stop <pad> [--json]
  paddock pad restart <pad> [--json]
  paddock pad recreate <pad> [--json]
  paddock runner status <runner-id> [--json]
  paddock runner pause <runner-id> [--json]
  paddock runner resume <runner-id> [--json]

Runs inside the Paddock control-plane container, including callback scripts.
PAD targets accept container names, bare names, or unambiguous display names.
Recreate preserves data and recreates managed forwarding doors. It ends the
PAD's terminal processes; session restoration is a separate recovery step.
Runner resume starts work. Runner pause stops future dispatch.

Callback example:
  /www1/test/log-arguments.sh --rotate testing
  paddock pad recreate "$PADDOCK_AGENT_NAME"

Use --json for machine-readable results. Progress and errors go to stderr.
Exit codes: 0 success, 1 operation failed, 2 invalid command or arguments.
`;

class UsageError extends Error {}

function parse(argv) {
  if (!argv.length || (argv.length === 1 && ['help', '--help', '-h'].includes(argv[0]))) return { help: true };
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  if (argv.filter((a) => a === '--json').length > 1 || args.some((a) => a.startsWith('-'))) throw new UsageError('Unknown or repeated option. Use paddock --help.');
  const [group, action, target] = args;
  const allowed = { pad: ['list', 'status', 'start', 'stop', 'restart', 'recreate'], runner: ['status', 'pause', 'resume'] };
  if (!allowed[group]?.includes(action)) throw new UsageError('Unknown command. Use paddock --help.');
  const count = group === 'pad' && action === 'list' ? 2 : 3;
  if (args.length !== count || (count === 3 && !target?.trim())) throw new UsageError(`Expected paddock ${group} ${action}${count === 3 ? ' <target>' : ''}.`);
  return { group, action, target, json };
}

function resolvePad(rows, value, prefix) {
  const key = value.toLowerCase();
  const exact = rows.filter((r) => r.name.toLowerCase() === key);
  if (exact.length === 1) return exact[0];
  const fullPrefix = prefix.endsWith('-') ? prefix : prefix + '-';
  const bare = rows.filter((r) => r.name.toLowerCase() === (fullPrefix + value).toLowerCase());
  if (bare.length === 1) return bare[0];
  const display = rows.filter((r) => r.display_name?.toLowerCase() === key);
  if (display.length === 1) return display[0];
  if (display.length > 1) throw new Error(`Ambiguous PAD '${value}': ${display.map((r) => r.name).join(', ')}`);
  throw new Error(`Managed PAD '${value}' not found. Use paddock pad list.`);
}

async function main(argv, dependencies = {}) {
  const out = dependencies.stdout || ((text) => process.stdout.write(text + '\n'));
  const err = dependencies.stderr || ((text) => process.stderr.write(text + '\n'));
  let command;
  try {
    command = parse(argv);
    if (command.help) { out(HELP); return 0; }
    const vm = dependencies.vm || require('./services/vm-manager');
    let result;
    if (command.group === 'pad') {
      const registry = dependencies.registry || require('./services/agent-registry');
      const rows = await registry.discoverAgents();
      if (command.action === 'list') {
        result = rows.map((r) => ({ name: r.name, displayName: r.display_name || r.name, status: r.status, type: r.agent_type }));
      } else {
        const pad = resolvePad(rows, command.target, vm.PREFIX);
        if (command.action === 'status') {
          const info = await vm.containerInfo(pad.name);
          result = { name: pad.name, status: info.state.status, running: !!info.state.running };
        } else {
          const methods = { start: 'startAgent', stop: 'stopAgent', restart: 'restartAgent', recreate: 'recreateAgent' };
          await vm[methods[command.action]](pad.name, { onLog: (stream, text) => err(String(text ?? stream).trimEnd()) });
          result = { name: pad.name, action: command.action, ok: true };
        }
      }
    } else {
      const mission = dependencies.mission || require('./services/mission');
      const runner = mission.getRunner(command.target);
      if (!runner) throw new Error(`Runner '${command.target}' not found.`);
      const actor = 'paddock-cli';
      if (command.action === 'pause') await mission.pauseRunner(runner.id, { actor });
      if (command.action === 'resume') {
        const resumed = await mission.startRunner(runner.id, { actor });
        if (resumed.started === false && !['already_running', 'empty_queue', 'quota_recovery_started'].includes(resumed.reason)) throw new Error(resumed.reason || 'Runner did not start');
      }
      const current = mission.getRunner(runner.id);
      result = { id: current.id, name: current.name, enabled: !!current.enabled, state: current.control_state, reason: current.last_reason || null };
    }
    out(command.json ? JSON.stringify(result) : Array.isArray(result)
      ? result.map((r) => `${r.name}\t${r.status}\t${r.type}`).join('\n') || 'No managed PADs.'
      : Object.entries(result).map(([k, v]) => `${k}: ${v ?? ''}`).join('\n'));
    return 0;
  } catch (e) {
    err(`paddock: ${e.message || String(e)}`);
    return e instanceof UsageError ? 2 : 1;
  }
}

module.exports = { main, parse, resolvePad };
