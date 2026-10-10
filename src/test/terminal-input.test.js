const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalInput } = require('../services/terminal-input');

const resize = (cols, rows) => Buffer.from('\x00\x00' + JSON.stringify({ type: 'resize', cols, rows }));

test('layout resize received during setup wins over URL dimensions', async () => {
  const input = createTerminalInput({ cols: 134, rows: 23 });
  const sizes = [];
  const writes = [];
  input.onMessage(resize(134, 20));
  input.onMessage(Buffer.from('premature-command\n'));
  const attached = await input.attach(
    { resize: async (size) => sizes.push(size) },
    { write: (data) => writes.push(data.toString()), destroyed: false }
  );
  assert.equal(attached, true);
  assert.deepEqual(sizes, [{ h: 20, w: 134 }]);
  assert.deepEqual(writes, [], 'input is not queued while attachment is pending');
  input.onMessage(Buffer.from('echo ready\n'));
  assert.deepEqual(writes, ['echo ready\n']);
});

test('a resize arriving during the initial Docker resize is applied before ready', async () => {
  const input = createTerminalInput({ cols: 134, rows: 23 });
  const sizes = [];
  let release;
  const pending = input.attach({ resize: async (size) => {
    sizes.push(size);
    if (sizes.length === 1) await new Promise((resolve) => { release = resolve; });
  } }, { write() { assert.fail('premature input'); }, destroyed: false });
  input.onMessage(resize(134, 20));
  input.onMessage(Buffer.from('not-ready\n'));
  release();
  assert.equal(await pending, true);
  assert.deepEqual(sizes, [{ h: 23, w: 134 }, { h: 20, w: 134 }]);
});

test('live resize, protocol separation, and disconnect retain existing behavior', async () => {
  const input = createTerminalInput({ cols: 120, rows: 32 });
  const sizes = [];
  const writes = [];
  await input.attach({ resize: async (size) => sizes.push(size) }, {
    write: (data) => writes.push(data.toString()), destroyed: false,
  });
  input.onMessage(resize(80, 18));
  input.onMessage(Buffer.from('\x00\x00not-json'));
  input.onMessage(Buffer.from('\x00\x00{"type":"other"}'));
  input.onMessage(Buffer.from('{"type":"resize","rows":9}'));
  assert.deepEqual(sizes, [{ h: 32, w: 120 }, { h: 18, w: 80 }]);
  assert.deepEqual(writes, ['{"type":"resize","rows":9}']);
  input.close();
  input.onMessage(resize(80, 30));
  input.onMessage(Buffer.from('closed\n'));
  assert.equal(sizes.length, 2);
  assert.equal(writes.length, 1);
});

test('closing during attachment never becomes ready', async () => {
  const input = createTerminalInput({ cols: 80, rows: 20 });
  let release;
  const pending = input.attach({ resize: () => new Promise((resolve) => { release = resolve; }) }, {
    write() { assert.fail('closed input'); }, destroyed: false,
  });
  input.close();
  release();
  assert.equal(await pending, false);
});

test('failed initial resize does not enable commands', async () => {
  const input = createTerminalInput({ cols: 80, rows: 20 });
  await assert.rejects(input.attach({ resize: async () => { throw new Error('resize failed'); } }, {
    write() { assert.fail('failed attachment input'); }, destroyed: false,
  }), /resize failed/);
  input.onMessage(Buffer.from('not-ready\n'));
});
