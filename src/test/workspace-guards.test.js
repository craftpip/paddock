// Plan 72 — the host-path policy for workspace / volume sources.
//
// `vm-manager.test.js` is deliberately NOT extended here: it carries an
// unrelated 264-line change in the worktree, and a plan's tests should not have
// to be interleaved with someone else's. Everything this plan owns is
// `workspace-guards.js`, and it is tested on its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The client copy is ESM and lives under the client package, so it is loaded
// through a dynamic `import()` (a real execution of the shipped code, not a
// re-implementation of it — a transcribed copy of the rule would keep passing
// after the client changed, which is exactly the drift this test exists to
// catch). It has no imports of its own, so it loads without the Vite resolver.
const CLIENT_GUARDS_SRC = path.join(__dirname, '..', 'client', 'src', 'lib', 'workspace-guards.js');
let clientModule = null;
async function client() {
  if (!clientModule) {
    clientModule = await import(require('url').pathToFileURL(CLIENT_GUARDS_SRC).href);
  }
  return clientModule;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('workspace-guards: home and scratch SUBDIRECTORIES are accepted', () => {
  const { hostSourceIssue } = require('../services/workspace-guards');
  // The user's actual complaint: real projects live in /root and /home, and
  // blocking the subpath protects nothing — the sensitive content is one level
  // down either way, so the rule was refusing the legitimate case only.
  for (const p of ['/root/craftpip.com', '/root/my-project', '/home/alice/proj', '/opt/app', '/tmp/build', '/mnt/data/x', '/srv/www']) {
    assert.equal(hostSourceIssue(p), null, `${p} should be accepted`);
  }
});

test('workspace-guards: the BARE scratch / app root is still refused, with a reason', () => {
  const { hostSourceIssue } = require('../services/workspace-guards');
  for (const p of ['/opt', '/tmp', '/srv', '/data']) {
    const issue = hostSourceIssue(p);
    assert.ok(issue, `${p} should be refused`);
    assert.equal(issue.code, 'workspace_source_home_root');
    // The message must be actionable: it has to name the dir and point at the
    // fix, or the user is back to "why is this not allowed?" with no answer.
    assert.match(issue.message, /pick a project folder inside it/);
    assert.ok(issue.message.includes(p), `message should name ${p}`);
  }
});

test('workspace-guards: /home, /root and /mnt are allowed BARE (plan 77)', () => {
  const { hostSourceIssue, HOST_USER_DATA } = require('../services/workspace-guards');
  // These are data / home roots the operator mounts whole on this host, so the
  // bare root is a legitimate source. Refusing them broke a recreate of a
  // working pad: `pad-opencode-proj` carries a stored /mnt extra volume, and a
  // network-only settings apply re-validated it against this guard.
  for (const p of ['/home', '/root', '/mnt']) {
    assert.equal(hostSourceIssue(p), null, `${p} should be accepted bare`);
    assert.ok(!HOST_USER_DATA.includes(p), `${p} must not be in the bare-root-refused list`);
  }
  // Their subdirectories obviously stay accepted too.
  for (const p of ['/home/u/proj', '/root/craftpip.com', '/mnt/data/x']) {
    assert.equal(hostSourceIssue(p), null, `${p} should be accepted`);
  }
});

test('workspace-guards: hard-block dirs are refused exact OR under', () => {
  const { hostSourceIssue } = require('../services/workspace-guards');
  for (const p of ['/etc', '/etc/passwd', '/etc/nginx', '/proc', '/proc/1', '/sys', '/dev', '/boot', '/bin', '/sbin', '/usr', '/usr/lib', '/lib', '/var/run']) {
    const issue = hostSourceIssue(p);
    assert.ok(issue, `${p} should be refused`);
    assert.equal(issue.code, 'workspace_source_system_dir');
  }
});

test('workspace-guards: /www1 stays allowed including BARE (a deliberate exclusion)', () => {
  const { hostSourceIssue, HOST_USER_DATA, HOST_HARD_BLOCK } = require('../services/workspace-guards');
  // craftpip and friends mount /www1/*; it is a projects root, not a home, and
  // it is allowed today. Listing it in either list would silently narrow a
  // working setup to buy a foot-gun nobody asked to be protected from.
  assert.equal(hostSourceIssue('/www1'), null);
  assert.equal(hostSourceIssue('/www1/craftpip'), null);
  assert.ok(!HOST_USER_DATA.includes('/www1'));
  assert.ok(!HOST_HARD_BLOCK.includes('/www1'));
});

test('workspace-guards: the host root is refused regardless of either guard', () => {
  const { hostSourceIssue } = require('../services/workspace-guards');
  withEnv({ GUARD_SYSTEM_DIRS: '0', GUARD_USER_DIRS: '0' }, () => {
    const issue = hostSourceIssue('/');
    assert.ok(issue, '/ should be refused even with both guards off');
    assert.equal(issue.code, 'workspace_source_host_root');
  });
  // '//' normalizes to '/', so it must not sneak past.
  assert.equal(hostSourceIssue('//').code, 'workspace_source_host_root');
});

test('workspace-guards: slash normalisation cannot be used to slip past', () => {
  const { hostSourceIssue } = require('../services/workspace-guards');
  assert.equal(hostSourceIssue('/opt/proj'), null);
  assert.equal(hostSourceIssue('/opt//proj//'), null, 'collapsed + trailing slash is a subdir');
  assert.equal(hostSourceIssue('/opt/').code, 'workspace_source_home_root', 'trailing slash is still bare');
  assert.equal(hostSourceIssue('//opt').code, 'workspace_source_home_root');
  assert.equal(hostSourceIssue('/etc//passwd').code, 'workspace_source_system_dir');
});

test('workspace-guards: non-absolute input is not this policy\'s business', () => {
  const { hostSourceIssue } = require('../services/workspace-guards');
  assert.equal(hostSourceIssue('instances/foo'), null);
  assert.equal(hostSourceIssue('relative/path'), null);
  assert.equal(hostSourceIssue(''), null);
  assert.equal(hostSourceIssue(undefined), null);
});

test('workspace-guards: the two guards are INDEPENDENT', () => {
  const { hostSourceIssue } = require('../services/workspace-guards');
  const code = (p, env) => withEnv(env, () => (hostSourceIssue(p) || {}).code || 'ok');

  assert.equal(code('/opt', {}), 'workspace_source_home_root');
  assert.equal(code('/etc', {}), 'workspace_source_system_dir');

  // GUARD_USER_DIRS relaxes ONLY the bare-root half.
  assert.equal(code('/opt', { GUARD_USER_DIRS: '0' }), 'ok');
  assert.equal(code('/etc', { GUARD_USER_DIRS: '0' }), 'workspace_source_system_dir');

  // GUARD_SYSTEM_DIRS is the pre-existing all-or-nothing hatch. It must not
  // silently become a way in to the bare user-data roots, or the plan's second
  // half would be undoable with one unrelated .env line.
  assert.equal(code('/etc', { GUARD_SYSTEM_DIRS: '0' }), 'ok');
  assert.equal(code('/opt', { GUARD_SYSTEM_DIRS: '0' }), 'workspace_source_home_root');

  // Both off = the old permissive behaviour, deliberately reachable.
  assert.equal(code('/opt', { GUARD_SYSTEM_DIRS: '0', GUARD_USER_DIRS: '0' }), 'ok');
  assert.equal(code('/etc', { GUARD_SYSTEM_DIRS: '0', GUARD_USER_DIRS: '0' }), 'ok');
});

test('workspace-guards: off-switch spellings all work', () => {
  const { hostSourceIssue } = require('../services/workspace-guards');
  for (const v of ['0', 'false', 'no', 'off', 'disabled', 'disable', 'OFF', ' False ']) {
    assert.equal(withEnv({ GUARD_USER_DIRS: v }, () => hostSourceIssue('/opt')), null, `GUARD_USER_DIRS=${v} should relax`);
  }
  assert.ok(hostSourceIssue('/opt'), 'unset means ON');
});

test('workspace-guards: the probe agrees with the policy (autocomplete un-hides them)', () => {
  const probe = require('../services/path-probe');
  // The probe has its own consumers — autocomplete filtering, volume discovery
  // — and if it still treated a user-data root as forbidden the form would offer
  // a path the create path then refuses. That is the client/server disagreement
  // this plan exists to close, so assert both halves of it.
  assert.equal(probe.isForbidden('/opt'), true);
  assert.equal(probe.isForbidden('/opt/app'), false);
  assert.equal(probe.isForbidden('/home/u/proj'), false);
  assert.equal(probe.isForbidden('/home'), false, 'plan 77: allowed bare');
  assert.equal(probe.isForbidden('/etc/passwd'), true);
  assert.equal(probe.isForbidden('/app'), true, 'paddock own dirs still blocked');
  assert.equal(probe.isForbidden('/workspace'), true);

  // Inherited compose volumes: a subdirectory of a user-data dir is inheritiable.
  assert.equal(probe.isDangerousSource('/opt/proj/node_modules'), false);
  assert.equal(probe.isDangerousSource('/opt'), true);
  assert.equal(probe.isDangerousSource('/etc'), true);
  assert.equal(probe.isDangerousSource('/var/run/docker.sock'), true);
});

test('workspace-guards: the probe REPORTS the human reason, so the form stops inventing one', () => {
  const probe = require('../services/path-probe');
  // The form rendered its own sentence ("System directory — cannot be a
  // workspace source.") beside the inline one. Now the reason comes from where
  // the policy lives, so the two cannot disagree about what is wrong.
  const bad = probe.probe('/opt');
  assert.equal(bad.forbidden, true);
  assert.ok(bad.reason, 'a forbidden path must carry a reason');
  assert.match(bad.reason, /pick a project folder inside it/);

  const sys = probe.probe('/etc');
  assert.equal(sys.forbidden, true);
  assert.match(sys.reason, /system directory \(\/etc\)/);

  const ok = probe.probe('/home/u');
  assert.equal(ok.issue, null);
  assert.equal(ok.forbidden, false);
});

test('workspace-guards: the CLIENT mirror returns the same verdict as the server', async () => {
  const { hostSourceIssue } = require('../services/workspace-guards');
  const { hostSourceIssue: clientFn } = await client();
  // The client cannot import the server module (require + the guard switch), so
  // it is a copy — and a copy is only safe if something proves the two agree.
  // Every path that means something, plus the ones that are easy to get wrong.
  const paths = [
    '/', '//', '/root', '/root/', '//root', '/root/proj', '/root//proj//', '/home', '/home/u', '/home/u/proj',
    '/etc', '/etc/passwd', '/proc', '/proc/1', '/sys', '/dev', '/boot', '/bin', '/sbin', '/usr', '/usr/lib',
    '/lib', '/var/run', '/var/run/docker.sock', '/opt', '/opt/app', '/tmp', '/tmp/build', '/mnt', '/srv', '/data',
    '/www1', '/www1/craftpip', '/app', '/workspace', '/workspace/instances',
  ];
  for (const p of paths) {
    const server = hostSourceIssue(p);
    const c = clientFn(p);
    assert.equal(c && c.code, server && server.code, `verdict differs for ${p}: client=${c && c.code} server=${server && server.code}`);
    assert.equal(c && c.message, server && server.message, `message differs for ${p}`);
  }
  // The noun is interpolated into the sentence, so it is asserted too: the
  // settings tab mounts the same rule as an extra volume's "host source", and a
  // shared module that said "workspace source" there would be wrong in the one
  // place a user reads it about a volume.
  assert.match(clientFn('/etc', { noun: 'host source' }).message, /host source cannot be a system directory/);
  assert.match(clientFn('/opt', { noun: 'host source' }).message, /whole home folder \(\/opt\) as a host source/);
});

test('workspace-guards: the client mirror also uses the same LISTS (a drift control)', async () => {
  const { HOST_HARD_BLOCK, HOST_USER_DATA } = require('../services/workspace-guards');
  const clientMod = await client();
  assert.deepEqual(clientMod.HOST_HARD_BLOCK, HOST_HARD_BLOCK, 'HOST_HARD_BLOCK drifted between server and client');
  assert.deepEqual(clientMod.HOST_USER_DATA, HOST_USER_DATA, 'HOST_USER_DATA drifted between server and client');
});

test('workspace-guards: no client file keeps a PRIVATE copy of the host-source rule', () => {
  // The rule was written out five times and each copy drifted — CreateAgent's
  // copy accepted what vm-manager refused, and the settings tab kept a copy
  // that refused /home/… outright, so a source the create form accepted was
  // refused when you went to change it. `/home` is the tell: every private
  // host-source list contained it, and no legitimate CONTAINER-destination
  // list may (that rule is a different question and stays local).
  const roots = ['pages', 'components', 'lib', 'stores', 'hooks'];
  const offenders = [];
  for (const dir of roots) {
    const full = path.join(__dirname, '..', 'client', 'src', dir);
    if (!fs.existsSync(full)) continue;
    for (const f of walk(full)) {
      if (!/\.(js|jsx)$/.test(f)) continue;
      if (f.endsWith(path.join('lib', 'workspace-guards.js'))) continue;
      const src = fs.readFileSync(f, 'utf8');
      if (/['"]\/home['"]/.test(src)) offenders.push(path.relative(path.join(__dirname, '..', 'client', 'src'), f));
    }
  }
  assert.deepEqual(offenders, [], `these files hold a private host-source list: ${offenders.join(', ')}`);
});

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test('workspace-guards: the server module exposes the guard switch the probe reads', () => {
  // The probe must resolve the SAME switches as vm-manager, or the form could
  // advertise a path the server refuses for an operator who turned a guard off.
  const { guard } = require('../services/workspace-guards');
  assert.equal(withEnv({ GUARD_USER_DIRS: undefined }, () => guard('USER_DIRS')), true);
  assert.equal(withEnv({ GUARD_USER_DIRS: '0' }, () => guard('USER_DIRS')), false);
  assert.equal(withEnv({ GUARD_SYSTEM_DIRS: undefined }, () => guard('SYSTEM_DIRS')), true);
});