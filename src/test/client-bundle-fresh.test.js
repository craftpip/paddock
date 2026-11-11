// The page serves the PREBUILT bundle in src/public, so "it renders" can be
// true of code that is not the code on disk (AGENTS.md: a committed JSX file
// that did not even parse rendered fine, because the bundle predated it).
// The build records a fingerprint of its inputs; this recomputes it.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const client = path.join(__dirname, '..', 'client');
const stampFile = path.join(__dirname, '..', 'public', 'build-stamp.json');

it('the served bundle was built from the client source on disk', async () => {
  assert.ok(fs.existsSync(stampFile), 'src/public/build-stamp.json is missing: run `npm run build` in src/client');
  const { sourceHash } = await import(pathToFileURL(path.join(client, 'build-stamp.js')).href);
  const built = JSON.parse(fs.readFileSync(stampFile, 'utf8')).sourceHash;
  assert.equal(built, sourceHash(client), 'the client source changed after the bundle was built: run `npm run build` in src/client, then commit src/public with it');
});

it('the bundle the page loads is the one on disk', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(assets.length >= 2, 'index.html references a script and a stylesheet');
  for (const asset of assets) assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', asset)), `${asset} is referenced by index.html but missing`);
});
