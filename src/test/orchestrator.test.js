// Plan 52 Phase D — orchestrator conferral. The role is exactly three things in
// one action (a full-reach key, the paddock MCP server wired into the pad, and
// the identity record + meta stamp), so the suite pins all three and the
// rollback that makes a half-conferral impossible.
//
// The docker exec and filesystem seams are the only things faked: vm-manager's
// fs/meta helpers are stubbed onto a temp dir and the exec runner is recorded,
// while apiKeys + the db are the REAL code paths against a throwaway DB. That
// is what makes "the key is created with scopes 'default'" and "a failed wire
// rolls the key back" genuine assertions instead of source-text pins.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-orch-'));
process.env.PAD_DB_PATH = path.join(TEST_DIR, 'orch.test.db');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { getDb } = require('../services/db');
const apiKeys = require('../services/api-keys');
const { getMcp } = require('../services/drivers');
const { getPaddockMcpUrl } = require('../services/paddock-mcp');
const orchestrator = require('../services/orchestrator');
const vm = require('../services/vm-manager');

describe('orchestrator conferral (plan 52 Phase D)', () => {
  const meta = {}; // name -> { ORCHESTRATOR?: '1' }
  const calls = []; // exec runner record
  let running = true;
  let keyIndex = 0;

  before(() => {
    const db = getDb();
    for (const u of ['u1', 'u2']) {
      db.prepare('INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)')
        .run(u, u + '-user', 'x');
    }
    for (const [name, type, owner] of [
      ['pad-orch-1', 'opencode', 'u1'],
      ['pad-orch-2', 'opencode', 'u1'],
      ['pad-orch-3', 'opencode', 'u2'],
    ]) {
      db.prepare(
        `INSERT OR REPLACE INTO agents (id, name, agent_type, runtime_type, runtime_ref, status, owner_id)
         VALUES (?, ?, ?, 'docker', ?, 'running', ?)`
      ).run(name, name, type, name, owner);
      meta[name] = {};
    }

    // Orchestrator's only real seam to docker is execInPad; vm-manager's fs/meta
    // helpers are stubbed onto TEST_DIR so the suite never writes the real
    // instances dir (a stray dir there reads as a fleet pad). All restored in
    // after() as PLAIN functions, per the bound-receiver restore rule.
    vm.driverConfigPath = (name, driver) =>
      path.join(TEST_DIR, name, driver.type, driver.configFile || 'openclaw.json');
    vm.readMeta = (dir) => meta[path.basename(dir)] || {};
    vm.setMetaFlag = (name, key, value) => {
      if (!meta[name]) meta[name] = {};
      if (value) meta[name][key] = value;
      else delete meta[name][key];
    };
    vm.isContainerRunning = async () => running;
    orchestrator._setExecRunner(async (name, script, input) => {
      calls.push({ i: ++keyIndex, name, script, input });
      return { stdout: '', stderr: '' };
    });
  });

  after(() => {
    vm.driverConfigPath = undefined;
    vm.readMeta = undefined;
    vm.setMetaFlag = undefined;
    vm.isContainerRunning = undefined;
    orchestrator._setExecRunner(null);
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  const connect = getMcp('opencode', getPaddockMcpUrl()).commands.connect;
  const disconnect = getMcp('opencode', getPaddockMcpUrl()).commands.disconnect;

  function configPath(name) {
    return path.join(TEST_DIR, name, 'opencode', 'orchestrator.json');
  }
  function readConfig(name) {
    try { return JSON.parse(fs.readFileSync(configPath(name), 'utf8')); } catch { return null; }
  }
  function orchKeys(userId) {
    return apiKeys.listForUser(userId).filter((k) => k.name === 'orchestrator');
  }

  it('confer wires the role: full-reach key, MCP server wired, identity record + meta stamp', async () => {
    calls.length = 0;
    const r = await orchestrator.confer('pad-orch-1', 'u1');

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.wired, true);

    // 1. the key exists with FULL reach (`default` — the conferral grant), owned
    //    by the user who asked. Hard-deletable, never revoked-in-place.
    const keys = orchKeys('u1');
    assert.strictEqual(keys.length, 1);
    assert.strictEqual(keys[0].scopes, 'default');
    assert.strictEqual(r.keyId, keys[0].id);

    // 2. the pad's OWN connect script ran with the key on stdin — the exact
    //    builder the driver ships (grammar stays in the drivers, plan 35b).
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, 'pad-orch-1');
    assert.strictEqual(calls[0].script, connect,
      'the exec ran the driver\'s connect script, not a bespoke spelling');
    assert.match(calls[0].script, /PADDOCK_MCP_TOKEN/, 'the script reads the token from stdin');
    // The key input is a real apiKeys payload, so it matches the prefix shape.
    assert.match(calls[0].input, /^pk_live_/, 'the key handed to the pad is the real api key');

    // 3. the identity record sits next to the driver config with Phase E's empty
    //    folders array (the editor is deferred to Phase E — D1 wires the role).
    const cfg = readConfig('pad-orch-1');
    assert.ok(cfg, 'orchestrator.json exists');
    assert.strictEqual(cfg.role, 'orchestrator');
    assert.ok(cfg.since, 'since is stamped');
    assert.deepStrictEqual(cfg.folders, []);

    // 4. meta says so.
    assert.strictEqual(meta['pad-orch-1'].ORCHESTRATOR, '1');

    // And the read surface agrees with what was done.
    const g = orchestrator.getOrchestrator('pad-orch-1', 'u1');
    assert.strictEqual(g.conferred, true);
    assert.strictEqual(g.keyId, keys[0].id);
    assert.strictEqual(g.since, cfg.since);
    assert.deepStrictEqual(g.folders, []);
    assert.ok(!g.keyLastUsedAt);
  });

  it('refuses when the pad is stopped — no key, no wiring, no record', async () => {
    // u2 has no conferral yet (the exclusivity test confers pad-orch-3 later),
    // so this refusal is the stopped-state one, not a naming collision.
    running = false;
    try {
      calls.length = 0;
      await assert.rejects(() => orchestrator.confer('pad-orch-3', 'u2'), (e) => {
        assert.strictEqual(e.code, 'agent_stopped');
        assert.strictEqual(e.status, 409);
        return true;
      });
      assert.strictEqual(orchKeys('u2').length, 0, 'no key was minted');
      assert.strictEqual(calls.length, 0, 'nothing ran in the container');
      assert.strictEqual(readConfig('pad-orch-3'), null, 'no identity record');
      assert.ok(!meta['pad-orch-3'].ORCHESTRATOR);
    } finally {
      running = true;
    }
  });

  it('a failed wire ROLLS BACK the whole grant — no orphan key, no record, no meta', async () => {
    const beforeKeys = orchKeys('u2').length;
    orchestrator._setExecRunner(async () => { throw new Error('docker exec: connect failed'); });
    try {
      calls.length = 0;
      await assert.rejects(() => orchestrator.confer('pad-orch-3', 'u2'), (e) => {
        assert.strictEqual(e.code, 'orchestrator_wiring_failed');
        assert.strictEqual(e.status, 500);
        assert.match(e.message, /connect failed/);
        return true;
      });
      assert.strictEqual(orchKeys('u2').length, beforeKeys, 'the just-created key was rolled back');
      assert.strictEqual(readConfig('pad-orch-3'), null);
      assert.ok(!meta['pad-orch-3'].ORCHESTRATOR);
    } finally {
      orchestrator._setExecRunner(async (name, script, input) => {
        calls.push({ i: ++keyIndex, name, script, input });
        return { stdout: '', stderr: '' };
      });
    }
  });

  it('refuses a second conferral: same pad (already) and a second pad (exclusivity)', async () => {
    await assert.rejects(() => orchestrator.confer('pad-orch-1', 'u1'), (e) => {
      assert.strictEqual(e.code, 'already_orchestrator');
      assert.strictEqual(e.status, 409);
      return true;
    });
    await assert.rejects(() => orchestrator.confer('pad-orch-2', 'u1'), (e) => {
      assert.strictEqual(e.code, 'orchestrator_exists');
      assert.match(e.message, /pad-orch-1/, 'the refusal NAMES the existing conferral');
      return true;
    });
    // Exclusivity is per-user: u2 has no conferral, so u2's own pad can.
    const r = await orchestrator.confer('pad-orch-3', 'u2');
    assert.ok(r.ok);
  });

  it('remove revokes the key, runs disconnect, and clears record + meta', async () => {
    calls.length = 0;
    const r = await orchestrator.removeConferral('pad-orch-1', 'u1');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.keyRevoked, true);
    assert.strictEqual(r.wiringLeftInContainer, false);
    assert.strictEqual(orchKeys('u1').length, 0, 'the key row is gone');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].script, disconnect, 'remove runs the driver\'s disconnect script');
    assert.strictEqual(readConfig('pad-orch-1'), null);
    assert.ok(!meta['pad-orch-1'].ORCHESTRATOR);
    assert.strictEqual(orchestrator.getOrchestrator('pad-orch-1', 'u1').conferred, false);
  });

  it('remove on a STOPPED pad still revokes; the inert entry is reported, not hidden', async () => {
    await orchestrator.confer('pad-orch-2', 'u1');
    running = false;
    try {
      calls.length = 0;
      const r = await orchestrator.removeConferral('pad-orch-2', 'u1');
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.keyRevoked, true);
      assert.strictEqual(r.wiringLeftInContainer, true,
        'a stopped container cannot be un-wired — saying "clean" would be a lie');
      assert.strictEqual(calls.length, 0, 'nothing ran: the pad is down');
      assert.strictEqual(orchKeys('u1').length, 0);
      assert.strictEqual(readConfig('pad-orch-2'), null);
      assert.ok(!meta['pad-orch-2'].ORCHESTRATOR);
    } finally {
      running = true;
    }
  });

  it('remove on an ordinary pad is refused — you cannot un-confer what never was', async () => {
    // pad-orch-1 was un-conferred earlier in this suite; nothing to remove.
    await assert.rejects(() => orchestrator.removeConferral('pad-orch-1', 'u1'), (e) => {
      assert.strictEqual(e.code, 'not_orchestrator');
      assert.strictEqual(e.status, 409);
      return true;
    });
    // u2's own conferral is untouched by that refusal.
    assert.strictEqual(orchestrator.getOrchestrator('pad-orch-3', 'u2').conferred, true);
  });
});