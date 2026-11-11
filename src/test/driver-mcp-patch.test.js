const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

// Plan 124 #2 and #13: what the per-driver "connect Paddock MCP" scripts do to
// a config file that already has other things in it. The scripts run INSIDE a
// PAD; here the same script text is run against a temp file.
const codex = require('../services/drivers/codex');
const picoclaw = require('../services/drivers/picoclaw');
const { bootstrap } = require('../services/drivers/mcp-util');

const TOKEN = 'pk_live_abcDEF123';

describe('codex: the Paddock key goes to the Paddock server only', () => {
  const CONFIG = [
    'model = "gpt-5"',
    '',
    '[mcp_servers.github]',
    'url = "https://api.example.test/mcp"',
    'bearer_token_env_var = "GITHUB_TOKEN"',
    '',
    '[mcp_servers.paddock]',
    'url = "http://10.0.0.1:6789/mcp"',
    'bearer_token_env_var = "PADDOCK_MCP_TOKEN"',
    '',
    '[mcp_servers.zeta]',
    'url = "https://zeta.example.test"',
    'bearer_token_env_var = "ZETA_TOKEN"',
    '',
  ].join('\n');

  it('leaves every other server exactly as it was', () => {
    const out = codex.patchPaddockAuth(CONFIG, TOKEN, 'paddock');
    assert.ok(out.includes('bearer_token_env_var = "GITHUB_TOKEN"'), 'a server before ours kept its own auth');
    assert.ok(out.includes('bearer_token_env_var = "ZETA_TOKEN"'), 'a server after ours kept its own auth');
    assert.equal(out.split(TOKEN).length - 1, 1, 'the key must appear exactly once in the file');
    const ours = out.slice(out.indexOf('[mcp_servers.paddock]'), out.indexOf('[mcp_servers.zeta]'));
    assert.match(ours, /http_headers = \{ Authorization = "Bearer pk_live_abcDEF123" \}/);
    assert.doesNotMatch(ours, /bearer_token_env_var/);
  });

  it('fails instead of writing when there is nothing of ours to patch', () => {
    assert.throws(() => codex.patchPaddockAuth('[mcp_servers.github]\nbearer_token_env_var = "GITHUB_TOKEN"\n', TOKEN, 'paddock'), /No \[mcp_servers\.paddock\]/);
    assert.throws(() => codex.patchPaddockAuth('[mcp_servers.paddock]\nurl = "x"\n', TOKEN, 'paddock'), /No bearer_token_env_var/);
  });

  it('refuses a key that would break out of the TOML string', () => {
    assert.throws(() => codex.patchPaddockAuth(CONFIG, 'x" }\nevil = "1', 'paddock'), /characters/);
    assert.throws(() => codex.patchPaddockAuth(CONFIG, '', 'paddock'), /empty/);
  });

  it('the function is self-contained: its source runs on its own, as it does in the PAD', () => {
    const src = `const f=${codex.patchPaddockAuth.toString()};process.stdout.write(f(${JSON.stringify(CONFIG)},${JSON.stringify(TOKEN)},"paddock"))`;
    const out = execFileSync(process.execPath, ['-e', src], { encoding: 'utf8' });
    assert.equal(out, codex.patchPaddockAuth(CONFIG, TOKEN, 'paddock'));
  });
});

describe('picoclaw: an unreadable config is not replaced', () => {
  /** The script the driver would run in the PAD, pointed at a temp file. */
  function run(builder, file) {
    const full = picoclaw.mcp[builder]({ url: 'http://10.0.0.1:6789/mcp' });
    const m = /node -e '([\s\S]*)'/.exec(full);
    assert.ok(m, 'the driver must still emit a node -e script');
    const script = m[1].replace(/'\\''/g, "'").split('/root/.picoclaw/config.json').join(file);
    return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, PADDOCK_MCP_TOKEN: TOKEN } });
  }
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pico-')), 'config.json');

  for (const builder of ['buildConnect', 'buildDisconnect']) {
    it(`${builder} stops, changing nothing, when config.json does not parse`, () => {
      const file = tmp();
      const broken = '{ "providers": { "openai": { "key": "sk-keepme" } }, }';
      fs.writeFileSync(file, broken);
      const r = run(builder, file);
      assert.notEqual(r.status, 0, 'a patch that could not read the config must fail');
      assert.match(r.stderr, /nothing was changed/);
      assert.equal(fs.readFileSync(file, 'utf8'), broken, 'the provider config must survive');
    });
  }

  it('connect keeps everything else in a valid config', () => {
    const file = tmp();
    fs.writeFileSync(file, JSON.stringify({ providers: { openai: { key: 'sk-keepme' } } }));
    const r = run('buildConnect', file);
    assert.equal(r.status, 0, r.stderr);
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(c.providers.openai.key, 'sk-keepme');
    assert.equal(c.tools.mcp.servers.paddock.headers.Authorization, `Bearer ${TOKEN}`);
  });

  it('connect starts a fresh config when there is none, or an empty one', () => {
    const file = tmp();
    assert.equal(run('buildConnect', file).status, 0);
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).tools.mcp.enabled);
    fs.writeFileSync(file, '');
    assert.equal(run('buildConnect', file).status, 0);
  });
});

describe('the connect wrapper reports what the wiring did', () => {
  const sh = (inner) => spawnSync('sh', ['-c', bootstrap(inner)], { input: TOKEN + '\n', encoding: 'utf8' });

  it('exits non-zero when a step fails, and does not run the steps after it', () => {
    const r = sh('false\necho SHOULD-NOT-RUN');
    assert.notEqual(r.status, 0, 'a failed `mcp add` used to exit 0 and was recorded as wired');
    assert.doesNotMatch(r.stdout, /SHOULD-NOT-RUN/);
  });

  it('exits zero when every step works, with the key available to them', () => {
    const r = sh('test "$PADDOCK_MCP_TOKEN" = pk_live_abcDEF123\necho wired');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /wired/);
  });
});
