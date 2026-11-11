const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const padTmux = require('../services/pad-tmux');

// pad-tmux talks to a PAD only through runCmd('docker', argv). The seam below
// records those argv arrays instead of running them, so the tests pin the exact
// command shape — which is the whole contract: a misplaced `-l` or a text value
// that went through a shell is a real bug, and neither shows up in a live test.
function recorder(replies = {}) {
  const calls = [];
  const fake = (cmd, args, options = {}) => {
    // Validate the options too, not just argv: execFile rejects a non-numeric
    // timeout at runtime, so a caller that passed {timeout,check} where a bare
    // number was expected would sail through a fake that ignored options.
    assert.ok(
      options.timeout === undefined || (Number.isInteger(options.timeout) && options.timeout > 0),
      `timeout must be a positive integer, got ${JSON.stringify(options.timeout)} (argv: ${args.join(' ')})`
    );
    calls.push({ cmd, args });
    const key = args.join(' ');
    for (const [pattern, reply] of Object.entries(replies)) {
      if (key.includes(pattern)) return Promise.resolve({ code: reply.code ?? 0, stdout: reply.stdout || '', stderr: reply.stderr || '' });
    }
    // Default: a probe finds nothing and a mutating tmux call fails, so a test
    // has to opt into each one it wants. `command -v tmux` and `new-session`
    // succeed by default (the happy path every create test needs); `has-session`
    // must be asked for explicitly, or every create test would short-circuit as
    // "already exists".
    const present = key.includes('command -v') || key.includes('new-session');
    return Promise.resolve({ code: present ? 0 : 1, stdout: present ? '/usr/bin/tmux\n' : '', stderr: '' });
  };
  return { calls, fake };
}

function findCall(calls, needle) {
  return calls.find((c) => c.args.join(' ').includes(needle));
}

beforeEach(() => {
  padTmux._setForTests({ resetReady: true });
});

afterEach(() => {
  padTmux._setForTests({ resetReady: true });
});

describe('pad-tmux - folder checks', () => {
  it('checks the folder inside the PAD, shell-quoted', async () => {
    const { calls, fake } = recorder({ 'test -d': { code: 0 } });
    padTmux._setForTests({ runCmd: fake });
    assert.equal(await padTmux.folderExists('pad-x', '/www2/paddock'), true);
    const probe = calls.find((c) => c.args.some((a) => a.includes('test -d')));
    assert.ok(probe, 'probed with test -d');
    assert.equal(probe.args[probe.args.length - 1], "test -d '/www2/paddock'");
  });

  it('neutralises a quote in a hostile folder string', async () => {
    const { calls, fake } = recorder({ 'test -d': { code: 1 } });
    padTmux._setForTests({ runCmd: fake });
    assert.equal(await padTmux.folderExists('pad-x', "/tmp'; rm -rf /; echo '"), false);
    const cmd = calls.find((c) => c.args.some((a) => a.includes('test -d'))).args.slice(-1)[0];
    assert.ok(!/;\s*rm -rf \/\s*;\s*echo\s+'$/.test(cmd), 'the injected ; rm is inside the quoted string');
    assert.equal(cmd, `test -d '/tmp'\\''; rm -rf /; echo '\\'''`);
  });

  it('reports false for an empty folder without running anything', async () => {
    const { calls, fake } = recorder();
    padTmux._setForTests({ runCmd: fake });
    assert.equal(await padTmux.folderExists('pad-x', ''), false);
    assert.equal(calls.length, 0);
  });
});

describe('pad-tmux - session creation', () => {
  it('roots the new session at cwd with -c', async () => {
    const { calls, fake } = recorder();
    padTmux._setForTests({ runCmd: fake });
    await padTmux.createSession('pad-x', 'msn-abcd1234', { cwd: '/www2/paddock' });
    const created = findCall(calls, 'new-session');
    assert.ok(created, 'new-session was called');
    const args = created.args;
    const i = args.indexOf('new-session');
    // argv: tmux new-session -d -s <name> [-c <cwd>] -x <c> -y <r> [shell]
    assert.equal(args[i + 1], '-d', 'detached');
    assert.equal(args[i + 2], '-s');
    assert.equal(args[i + 3], 'msn-abcd1234');
    assert.equal(args[i + 4], '-c', 'the folder is passed with -c');
    assert.equal(args[i + 5], '/www2/paddock');
  });

  it('sets the PAD-wide options in the same invocation, before the session is created (plan 123 #8)', async () => {
    // `set-option -g` cannot start a tmux server, so options set ahead of
    // time are lost on a PAD with no session yet. They have to travel with
    // the command that creates the first one, and come before it.
    const { calls, fake } = recorder();
    padTmux._setForTests({ runCmd: fake });
    await padTmux.createSession('pad-x', 'msn-abcd1234', { cwd: '/www2/paddock' });
    const args = findCall(calls, 'new-session').args;
    const at = (word) => args.indexOf(word);
    assert.notEqual(at('start-server'), -1, 'the server is started in this invocation');
    assert.notEqual(at('escape-time'), -1, 'escape-time is set');
    assert.notEqual(at('history-limit'), -1, 'history-limit is set');
    assert.notEqual(at('new-session'), -1);
    assert.ok(at('start-server') < at('escape-time') && at('escape-time') < at('new-session'), 'options come after start-server and before new-session');
    assert.ok(at('history-limit') < at('new-session'), 'history-limit is in force for the first window');
    assert.equal(args[at('escape-time') + 1], '10');
  });

  it('omits -c entirely when no cwd is given (terminal sessions)', async () => {
    const { calls, fake } = recorder();
    padTmux._setForTests({ runCmd: fake });
    await padTmux.createSession('pad-x', 'main');
    const args = findCall(calls, 'new-session').args;
    assert.ok(!args.includes('-c'), 'no -c for a plain terminal session');
  });

  it('creates nothing when the session already exists', async () => {
    // has-session answers 0, i.e. the session is there.
    const { calls, fake } = recorder({ 'has-session': { code: 0 } });
    padTmux._setForTests({ runCmd: fake });
    const r = await padTmux.createSession('pad-x', 'msn-abcd1234', { cwd: '/www1' });
    assert.equal(r.created, false);
    assert.ok(!findCall(calls, 'new-session'), 'never re-created a live session');
  });

  it('rolls a missing folder back into a message about the folder', async () => {
    const { calls, fake } = recorder({ 'new-session': { code: 1, stderr: 'no such file or directory' } });
    padTmux._setForTests({ runCmd: fake });
    await assert.rejects(
      padTmux.createSession('pad-x', 'msn-abcd1234', { cwd: '/www1/gone' }),
      /The folder \/www1\/gone does not exist inside pad-x/
    );
  });

  it('refuses an unsafe session name before running anything', async () => {
    const { calls, fake } = recorder();
    padTmux._setForTests({ runCmd: fake });
    assert.throws(() => padTmux.assertSessionName('a; rm -rf /'), /unsafe tmux session name/);
    assert.throws(() => padTmux.assertSessionName(''), /unsafe tmux session name/);
    assert.equal(calls.length, 0, 'nothing was executed');
  });
});

describe('pad-tmux - send-keys', () => {
  it('quota recovery pastes one atomic buffer before Enter rather than flooding literal key events', async () => {
    const { calls, fake } = recorder();
    padTmux._setForTests({ runCmd: fake });
    await padTmux.sendText('pad-x', 'msn-abcd1234', 'continue $(literal)', { paste: true });
    const set = calls.findIndex((c) => c.args.includes('set-buffer'));
    const paste = calls.findIndex((c) => c.args.includes('paste-buffer'));
    const enter = calls.findIndex((c) => c.args[c.args.length - 1] === 'Enter');
    assert.ok(set >= 0 && paste > set && enter > paste);
    assert.equal(calls[set].args.at(-1), 'continue $(literal)');
    assert.ok(calls[paste].args.includes('-p'));
    assert.ok(calls[paste].args.includes('-d'));
    assert.ok(!calls.some((c) => c.args.includes('-l')));
  });
  it('sends text literally, as argv, then a separate Enter', async () => {
    const { calls, fake } = recorder();
    padTmux._setForTests({ runCmd: fake });
    await padTmux.sendText('pad-x', 'msn-abcd1234', 'fix the parser');
    const literal = calls.find((c) => c.args.includes('-l'));
    assert.ok(literal, 'used send-keys -l');
    const a = literal.args;
    assert.ok(a.includes('--'), '-- ends option parsing so a leading dash is safe');
    assert.equal(a[a.length - 1], 'fix the parser', 'the text is one argv element, unquoted/unreparsed');
    assert.ok(!a.includes('sh'), 'never goes through a shell');
    const enter = calls.find((c) => c.args[c.args.length - 1] === 'Enter');
    assert.ok(enter, 'Enter is its own send-keys, not part of the text');
  });

  it('keeps shell metacharacters inert', async () => {
    const { calls, fake } = recorder();
    padTmux._setForTests({ runCmd: fake });
    const nasty = 'run $(rm -rf /) && echo `whoami`';
    await padTmux.sendText('pad-x', 'msn-abcd1234', nasty);
    const literal = calls.find((c) => c.args.includes('-l'));
    assert.equal(literal.args[literal.args.length - 1], nasty, 'the exact string, as data');
  });

  it('sends each line of a multi-line prompt with its own Enter', async () => {
    const { calls, fake } = recorder();
    padTmux._setForTests({ runCmd: fake });
    const r = await padTmux.sendText('pad-x', 'msn-abcd1234', 'line one\nline two');
    assert.equal(r.lines, 2);
    assert.equal(calls.filter((c) => c.args.includes('-l')).length, 2);
    assert.equal(calls.filter((c) => c.args[c.args.length - 1] === 'Enter').length, 2);
  });

  it('launches a command literally too (the TUI launch path)', async () => {
    const { calls, fake } = recorder();
    padTmux._setForTests({ runCmd: fake });
    await padTmux.sendCommand('pad-x', 'msn-abcd1234', 'codex -C /www2/paddock');
    const literal = calls.find((c) => c.args.includes('-l'));
    assert.equal(literal.args[literal.args.length - 1], 'codex -C /www2/paddock');
  });

  it('sends nothing for an empty string', async () => {
    const { calls, fake } = recorder();
    padTmux._setForTests({ runCmd: fake });
    const r = await padTmux.sendText('pad-x', 'msn-abcd1234', '');
    assert.equal(r.lines, 0);
    assert.equal(calls.length, 0);
  });
});

describe('pad-tmux - reading a session back', () => {
  it('captures the last N lines of the pane', async () => {
    const { calls, fake } = recorder({ 'capture-pane': { stdout: 'a\nb\nc\n' } });
    padTmux._setForTests({ runCmd: fake });
    const r = await padTmux.captureScreen('pad-x', 'msn-abcd1234', 40);
    const a = findCall(calls, 'capture-pane').args;
    assert.ok(a.includes('-p'), 'print mode, no escape codes');
    assert.equal(a[a.length - 1], '-40', 'asks the pane for 40 lines back');
    assert.equal(r.text, 'a\nb\nc');
    assert.equal(r.live, true);
  });

  it('reports a dead session instead of throwing', async () => {
    const { fake } = recorder({ 'capture-pane': { code: 1, stderr: "can't find session" } });
    padTmux._setForTests({ runCmd: fake });
    const r = await padTmux.captureScreen('pad-x', 'msn-abcd1234');
    assert.deepEqual(r, { text: '', live: false });
  });

  it('tells a running TUI from a pane that fell back to the shell', async () => {
    const tui = recorder({ 'has-session': { code: 0 }, 'display-message': { stdout: 'node|/www2/paddock' } });
    padTmux._setForTests({ runCmd: tui.fake });
    let s = await padTmux.paneState('pad-x', 'msn-abcd1234');
    assert.equal(s.live, true);
    assert.equal(s.tuiAlive, true, 'node in the foreground = the TUI is up');
    assert.equal(s.cwd, '/www2/paddock');

    const shell = recorder({ 'has-session': { code: 0 }, 'display-message': { stdout: 'bash|/www2/paddock' } });
    padTmux._setForTests({ runCmd: shell.fake });
    s = await padTmux.paneState('pad-x', 'msn-abcd1234');
    assert.equal(s.live, true, 'the tmux session is still there');
    assert.equal(s.tuiAlive, false, 'but the TUI exited — this is the Relaunch TUI case');

    const gone = recorder({ 'has-session': { code: 1 } });
    padTmux._setForTests({ runCmd: gone.fake });
    s = await padTmux.paneState('pad-x', 'msn-abcd1234');
    assert.deepEqual(s, { live: false, tuiAlive: false, command: '', cwd: '', reason: 'no-session' });
  });

  it('builds a whole PAD\'s pane map in one call, keyed by session name', async () => {
    // The point of `list-panes -a` is that list mode can say "shell" for 20
    // sessions with ONE exec. A per-session `paneState` here is the O(sessions)
    // cost this replaced, so the argv is pinned.
    const out = [
      'msn-abcd1234|node|/www2/paddock',
      'msn-efgh5678|bash|/www1/other',
      'term-1|zsh|/root',
    ].join('\n');
    const { calls, fake } = recorder({ 'list-panes': { stdout: out }, 'has-session': { code: 0 } });
    padTmux._setForTests({ runCmd: fake });
    const map = await padTmux.listPanes('pad-x');
    const a = findCall(calls, 'list-panes').args;
    assert.ok(a.includes('-a'), 'every pane on the PAD, not one session\'s');
    assert.deepEqual([...map.keys()], ['msn-abcd1234', 'msn-efgh5678', 'term-1']);
    assert.deepEqual(map.get('msn-abcd1234'), { command: 'node', cwd: '/www2/paddock' });
    assert.deepEqual(map.get('msn-efgh5678'), { command: 'bash', cwd: '/www1/other' });
    assert.equal(findCall(calls, 'display-message'), undefined, 'no per-row probe');
  });

  it('an unreadable pane map is empty, not a thrown list', async () => {
    const { fake } = recorder({ 'list-panes': { code: 1, stderr: 'no server running' } });
    padTmux._setForTests({ runCmd: fake });
    const map = await padTmux.listPanes('pad-x');
    assert.equal(map.size, 0, 'callers treat empty as "no claim", which is the safe direction');
  });

  it('a malformed line is skipped rather than producing a half-parsed pane', async () => {
    const out = ['msn-abcd1234|node', '|', 'msn-efgh5678|bash|/www1/other', ''].join('\n');
    const { fake } = recorder({ 'list-panes': { stdout: out }, 'has-session': { code: 0 } });
    padTmux._setForTests({ runCmd: fake });
    const map = await padTmux.listPanes('pad-x');
    assert.deepEqual([...map.keys()], ['msn-efgh5678'], 'only the complete line survived');
  });

  it('listSessions tells "no sessions" from "could not look" (plan 123 #18)', async () => {
    // No tmux server is a real, empty answer.
    let r = recorder({ 'list-sessions': { code: 1, stderr: 'no server running on /tmp/tmux-0/default' } });
    padTmux._setForTests({ runCmd: r.fake });
    assert.deepEqual(await padTmux.listSessions('pad-x'), []);
    // A docker failure is not: returning [] here made every caller conclude
    // that all the PAD's sessions had died, and date them so.
    r = recorder({ 'list-sessions': { code: 1, stderr: 'Error response from daemon: container abc is not running' } });
    padTmux._setForTests({ runCmd: r.fake });
    await assert.rejects(() => padTmux.listSessions('pad-x'), /Could not list tmux sessions in pad-x: .*is not running/);
  });

  it('isShellCommand knows the shells a pane actually falls back to', () => {
    // `pane_current_command` is a single word, so this is a closed list: an
    // unknown value is treated as a shell because "not evidence of a TUI" is the
    // safe direction — a wrong 'shell' refuses a send, a wrong 'agent' types
    // text into a bash pane.
    for (const s of ['bash', 'zsh', 'sh', 'dash', ' sh ', 'ash', 'fish', 'ksh', '-bash', 'busybox']) {
      assert.equal(padTmux.isShellCommand(s), true, `${s} is a shell`);
    }
    for (const c of ['node', 'opencode', 'python3', 'vim', 'ssh']) {
      assert.equal(padTmux.isShellCommand(c), false, `${c} is not a shell`);
    }
    assert.equal(padTmux.isShellCommand(''), true, 'an unknown command is not evidence of a TUI');
  });

  it('sends key NAMES, so the dialog moves — the opposite of sendText\'s -l', async () => {
    // `-l` means "type these bytes literally", so `send-keys -l Home` types the
    // four characters H-o-m-e into the pane instead of pressing Home. That is
    // exactly what sendText needs and exactly what would break a permission
    // dialog, so the ABSENCE of -l here is the contract, and asserting its
    // presence is the mistake this test exists to prevent.
    const { calls, fake } = recorder({ 'send-keys': { code: 0 } });
    padTmux._setForTests({ runCmd: fake });
    await padTmux.sendKeys('pad-x', 'msn-abcd1234', ['Home', 'Enter']);
    const sent = calls.filter((c) => c.args.join(' ').includes('send-keys'));
    assert.equal(sent.length, 2, 'one exec per key: "Home Enter" as one string would depend on tmux\'s separator parsing');
    for (const s of sent) {
      assert.ok(!s.args.includes('-l'), `a key name must be interpreted, not typed: ${s.args.join(' ')}`);
    }
    assert.equal(sent[0].args[sent[0].args.length - 1], 'Home');
    assert.equal(sent[1].args[sent[1].args.length - 1], 'Enter');
  });
});

describe('pad-tmux - cleanup', () => {
  it('treats killing a session that is already gone as success', async () => {
    const { fake } = recorder({ 'kill-session': { code: 1, stderr: "can't find session: msn-abcd1234" } });
    padTmux._setForTests({ runCmd: fake });
    assert.equal(await padTmux.killSession('pad-x', 'msn-abcd1234'), true);
  });

  it('surfaces a real kill failure', async () => {
    const { fake } = recorder({ 'kill-session': { code: 1, stderr: 'permission denied' } });
    padTmux._setForTests({ runCmd: fake });
    await assert.rejects(padTmux.killSession('pad-x', 'msn-abcd1234'), /permission denied/);
  });

  it('lists sessions with the | delimiter tmux cannot mangle', async () => {
    const { calls, fake } = recorder({ 'list-sessions': { stdout: 'main|1|1700000000\nmsn-abcd1234|0|1700000001\n' } });
    padTmux._setForTests({ runCmd: fake });
    const rows = await padTmux.listSessions('pad-x');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, 'main');
    assert.equal(rows[0].attached, true);
    assert.equal(rows[1].name, 'msn-abcd1234');
    assert.equal(rows[1].attached, false);
    assert.ok(findCall(calls, 'list-sessions').args.some((a) => a.includes('|')), 'uses | not \\t');
  });
});
