// Plan 124 #10: which pool /24s a docker network's subnet makes unusable.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'subnet-pool-'));
const { padPoolOctetsCovered, padPoolOctet, pickFreePadSubnet, _setNetworkSubnets } = require('../services/vm-manager/subnets');

it('a /24 inside the pool covers exactly its own octet', () => {
  assert.deepEqual(padPoolOctetsCovered('10.200.7.0/24'), [7]);
  assert.deepEqual(padPoolOctetsCovered('10.200.255.0/24'), [255]);
});

it('a wider foreign network covers every /24 it overlaps', () => {
  assert.deepEqual(padPoolOctetsCovered('10.200.0.0/20'), Array.from({ length: 16 }, (_, i) => i));
  assert.deepEqual(padPoolOctetsCovered('10.200.16.0/22'), [16, 17, 18, 19]);
  assert.equal(padPoolOctetsCovered('10.200.0.0/16').length, 256);
  assert.equal(padPoolOctetsCovered('10.0.0.0/8').length, 256, 'a network that contains the whole pool uses all of it');
});

it('a narrower network still spoils the /24 it sits in', () => {
  assert.deepEqual(padPoolOctetsCovered('10.200.7.128/25'), [7]);
});

it('networks outside the pool cover nothing', () => {
  for (const cidr of ['10.201.0.0/24', '10.199.254.0/23', '172.17.0.0/16', '192.168.1.0/24', 'not-a-subnet', '']) {
    assert.deepEqual(padPoolOctetsCovered(cidr), [], cidr);
  }
});

it('the reservation reader is unchanged: only an exact pool /24 is a reservation', () => {
  assert.equal(padPoolOctet('10.200.7.0/24'), 7);
  assert.equal(padPoolOctet('10.200.0.0/20'), null);
});

it('the picker skips every /24 inside a wider foreign network', () => {
  _setNetworkSubnets(() => ['172.18.0.0/16', '10.200.0.0/20', '10.200.16.0/24']);
  try {
    assert.equal(pickFreePadSubnet('pad-new'), '10.200.17.0/24');
  } finally { _setNetworkSubnets(null); }
});

it('the picker refuses to pick when the networks could not be listed', () => {
  _setNetworkSubnets(() => { throw new Error('Could not list docker networks to pick a free PAD subnet: daemon down'); });
  try {
    assert.throws(() => pickFreePadSubnet('pad-new'), /Could not list docker networks/);
  } finally { _setNetworkSubnets(null); }
});

it('and says the pool is full when one network holds all of it', () => {
  _setNetworkSubnets(() => ['10.0.0.0/8']);
  try {
    assert.equal(pickFreePadSubnet('pad-new'), '');
  } finally { _setNetworkSubnets(null); }
});
