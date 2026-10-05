'use strict';
/**
 * Plan 76 — fail-closed driver resolution.
 *
 * The bug this pins: `getDriver(type)` used to be `drivers[type] || openclaw`,
 * so an unknown type answered with a *complete, confident* openclaw answer.
 * Measured live: `/api/agent-types/opencodee/commands` returned HTTP 200 with
 * `type: "openclaw"`, openclaw's 4 commands, openclaw's MCP connect block and
 * `tuiCommand: "openclaw"`. Nothing threw, nothing was logged, and the response
 * even named the substitution — so the wrong answer was indistinguishable from
 * success and surfaced much later as a confidently incorrect path.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getDriver, getDriverOr, hasDriver, listDrivers, getLlmCatalog, getMcp, drivers,
} = require('../services/drivers');

const KNOWN = Object.keys(drivers);

test('getDriver: every registered type resolves to its own driver', () => {
  for (const type of KNOWN) {
    assert.strictEqual(getDriver(type).type, type, `${type} resolved to the wrong driver`);
  }
});

test('getDriver THROWS for a misspelled type, naming it and the valid set', () => {
  // Presence of both operands is asserted before the order/shape of the message
  // matters, or an `indexOf` on absent text reports success (-1 is "not found").
  let err = null;
  try {
    getDriver('opencodee');
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'a misspelled type must not resolve');
  assert.match(err.message, /unknown_agent_type/);
  assert.match(err.message, /opencodee/, 'the message must name the type that was asked for');
  for (const type of KNOWN) {
    assert.ok(err.message.includes(type), `the message must list the valid set (missing ${type})`);
  }
});

test('getDriver THROWS for the empty-ish types a bad row can carry', () => {
  // `agent_type` is TEXT NOT NULL DEFAULT 'openclaw' with no CHECK constraint,
  // and `meta.env`'s AGENT line is hand-editable, so these all genuinely reach
  // the function — and every one of them used to answer "openclaw".
  for (const bad of ['', '   ', 'open code', 'OpenCode', 'opencode ', 'claudee', null, undefined, 42, {}]) {
    assert.throws(
      () => getDriver(bad),
      /unknown_agent_type/,
      `getDriver(${JSON.stringify(bad)}) must not silently become openclaw`
    );
  }
});

test('getDriver is not fooled by prototype keys', () => {
  // `drivers[type] || openclaw` would have handed back Object.prototype for
  // these. hasDriver uses hasOwnProperty precisely so it cannot.
  for (const k of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
    assert.strictEqual(hasDriver(k), false, `${k} must not count as a driver`);
    assert.throws(() => getDriver(k), /unknown_agent_type/);
  }
});

test('hasDriver answers the validating question, not the resolving one', () => {
  assert.strictEqual(hasDriver('opencode'), true);
  assert.strictEqual(hasDriver('kk'), false);
  assert.strictEqual(hasDriver(''), false);
  assert.strictEqual(hasDriver(undefined), false);
  // Every type the CreateAgent select can offer must pass validation, or the
  // picker offers a type its own commands route would 404.
  for (const d of listDrivers()) {
    assert.strictEqual(hasDriver(d.type), true, `${d.type} is listed but not resolvable`);
  }
});

test('getDriverOr forgives an ABSENT type — a pad with no AGENT line', () => {
  // Real, measured state: 3 live pads carry no AGENT line at all. This is the
  // leniency the plan's three named sites depend on, and it stays.
  for (const absent of [undefined, null, '', '   ']) {
    assert.strictEqual(getDriverOr(absent).type, 'openclaw', `absent ${JSON.stringify(absent)} must fall back`);
  }
});

test("getDriverOr's fallback is a parameter, so the leniency is testable", () => {
  assert.strictEqual(getDriverOr(undefined, 'codex').type, 'codex');
  assert.strictEqual(getDriverOr('', 'claude').type, 'claude');
  assert.strictEqual(getDriverOr(null).type, 'openclaw', 'the default fallback is openclaw');
  // A fallback that is not a driver is a caller bug, and is reported as one
  // rather than resolving to nothing.
  assert.throws(() => getDriverOr(undefined, 'codexx'), /unknown_driver_fallback/);
});

test('getDriverOr does NOT forgive a PRESENT type it cannot resolve', () => {
  // This is the one deviation from the plan as written. The plan proposed
  // `getDriverOr('opencodee')` → openclaw, which keeps the substitution alive
  // behind a safer name: a recorded type we read and could not resolve is a
  // FACT, not an absence, and answering it with another agent's driver is the
  // exact failure this plan exists to stop. It must still throw.
  assert.throws(() => getDriverOr('opencodee'), /unknown_agent_type/);
  assert.throws(() => getDriverOr('claudee', 'codex'), /unknown_agent_type/);
  // ...and a known type still resolves normally through the lenient entry point.
  assert.strictEqual(getDriverOr('codex', 'openclaw').type, 'codex');
});

test("plan 53's mechanism still holds: getDriverOr does not invent a mission flag", () => {
  // Plan 53 documented the fallback as the reason `mission.supported` is a safe
  // `?.` read everywhere: an unsupported agent was meant to read as unsupported
  // BY FALLING BACK to openclaw, which carries no `mission` flag. Splitting the
  // function must not have quietly removed that.
  const openclaw = getDriverOr(undefined);
  assert.equal(openclaw.mission, undefined, 'the openclaw fallback must still carry no mission flag');
  assert.equal(!!(openclaw.mission && openclaw.mission.supported), false);
  // And the same for an unsupported type reached through the lenient path.
  assert.equal(!!(getDriverOr('picoclaw').mission && getDriverOr('picoclaw').mission.supported), false);
  // While the coding models keep it, so mission.supported is still meaningful.
  for (const t of ['opencode', 'codex', 'claude']) {
    assert.equal(getDriver(t).mission && getDriver(t).mission.supported, true, `${t} should support Mission`);
  }
});

test('getLlmCatalog / getMcp refuse an unknown type instead of describing openclaw', () => {
  // These are what the 404'd route serves. If they ever went lenient again, the
  // route's own 404 would be the only thing standing between a typo and a
  // complete openclaw answer, and they are also reachable from mcp.js.
  assert.throws(() => getLlmCatalog('opencodee'), /unknown_agent_type/);
  assert.throws(() => getMcp('opencodee', 'http://x/mcp'), /unknown_agent_type/);
  assert.strictEqual(getLlmCatalog('codex').type, 'codex');
  assert.strictEqual(getMcp('codex', 'http://x/mcp').type, 'codex');
});

test('no exported entry point resolves an unknown type to openclaw', () => {
  // A behavioural guard rather than a regex over the source: the throw tests
  // above already go red if the `|| openclaw` fallback returns, and a
  // text assertion here was only ever going to match a doc comment (it did) or
  // miss a helper added under another name. What this actually protects is the
  // EXPORTED SURFACE — if a future reader adds a convenient lenient resolver and
  // wires a call site to it, the substitution is reachable again, and this is
  // the test that says so. Only `getDriverOr` may answer with a fallback, and
  // only for an absent type.
  const api = require('../services/drivers');
  const lenientByDesign = new Set(['getDriverOr']);
  // `listDrivers()` takes no type and answers "every type" — that is its job,
  // not a filter falling back to an unfiltered answer, so it is out of scope.
  const typeFree = new Set(['listDrivers']);
  for (const [name, fn] of Object.entries(api)) {
    if (typeof fn !== 'function' || lenientByDesign.has(name) || typeFree.has(name)) continue;
    let resolved = null;
    try {
      resolved = fn('opencodee', { url: 'http://x/mcp' });
    } catch {
      continue; // refusing is the correct answer
    }
    // `hasDriver` answers a boolean, not a driver, so it never reaches here.
    if (resolved === null || typeof resolved !== 'object') continue;
    assert.fail(
      `${name}('opencodee') returned ${JSON.stringify(resolved)} instead of refusing — `
      + 'an unknown type must never be answered with another agent\'s data'
    );
  }
});