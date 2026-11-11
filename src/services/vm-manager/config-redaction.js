/**
 * Reading an agent's config for callers outside the process, with secrets redacted.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  readAgentConfig, redactSecrets,
});

const fs = require('fs');
const path = require('path');
const { getDriver } = require('./internal');

const REDACTED = '[REDACTED]';

/** A key whose VALUE is a credential. Tested against the NORMALIZED key (see
 *  `normalizeKey`) as either the whole word or a `_`-terminated SUFFIX, which is
 *  the rule the plan called for and the one that generalises past a fixed list:
 *  `apiKey`, `api_key` and `API-KEY` are one rule, and `x_mcp_key` /
 *  `anthropic_auth_token` are caught by their last segment — spellings an
 *  equality test on a closed list never sees.
 *
 *  SUFFIX, not "any segment", on purpose. A segment rule over-reaches into keys
 *  that merely CONTAIN a credential word: it eats `tokenLimit` (a number),
 *  `passwordPolicy` (a policy name) and `monacoKeyBinding`, and every one of
 *  those is a fact the LLM needs to read the config. A suffix still catches
 *  every real credential name, because they are named after the thing:
 *  `rootPassword`, `dbPassword`, `sshPassword`, `refreshToken`, `xMcpKey`. */
const SECRET_KEY_RE = /(^|_)(api_?key|auth|authorization|credential|credentials|key|pass|passwd|password|secret|token)$/;

/** The suffix rule's one systematic false positive: a `*_key` that is a *noun*,
 *  not a credential. `sortKey`, `cacheKey`, `primaryKey` and `keyboardLayout`
 *  are facts an LLM needs in order to read the config, and redacting them makes
 *  the tool quietly wrong in a way nobody can detect. Kept deliberately short:
 *  an allowlist is only safe while it is a list of words that are never
 *  credentials, so anything credential-shaped stays redacted. */
const NON_SECRET_KEY_SUFFIX = /^(sort|cache|primary|foreign|partition|object|row|column|index|grouping|group|sorting|hash|digest|keyboard|hotkey|keymap|icon|layout|config|env|css|translation|i18n|msg|message)_key$/;

/** A key that names a MAP of request headers. The map's *shape* is the signal,
 *  not its key names: HTTP header names are the server's choice
 *  (`authorization`, `X-MCP-Key`, `Proxy-Authorization`, a vendor's own), so
 *  redacting a fixed list of header names is the same class of bug as the key
 *  list above. Every value under one of these is redacted wholesale.
 *
 *  SUFFIX match, not equality — `httpHeaders`, `defaultHeaders` and
 *  `extraHeaders` are the same map under three names, and an anchored rule
 *  quietly protects only the spelling you happened to test.
 *  `env`/`environment` is here for the same reason: an env map is a bag of
 *  credentials (`API_KEY`, `TOKEN`, a `DATABASE_URL` with an inline password)
 *  whose values the LLM rarely needs, and a miss is a live secret. */
const HEADERS_KEY_RE = /(^|_)(headers?|env(ironment)?)($|_)/;

/** `apiKey` / `API-KEY` / `x-mcp-key` are the SAME word. Without this the two
 *  regexes above only ever see the separator style each config happens to use —
 *  which is exactly the bug they were written to fix, one level down. */
function normalizeKey(k) {
  return String(k)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
}

/** True when a value under `k` must never leave the process. */
function isSecretKey(k) {
  const n = normalizeKey(k);
  if (NON_SECRET_KEY_SUFFIX.test(n)) return false;
  return SECRET_KEY_RE.test(n) || HEADERS_KEY_RE.test(n);
}

/** Line-level scrub for the non-JSON config formats (yaml / toml), which have
 *  no parser on this path. Matches `key: value` and `key = value` (and quoted
 *  keys) whose key is a secret per `isSecretKey`, and blanks the value. Comments
 *  and blank lines pass through untouched. */
function redactConfigText(text) {
  return String(text).split('\n').map((line) => {
    const m = /^(\s*(?:-\s*)?)(["']?)([A-Za-z0-9_.\-]+)\2(\s*[:=]\s*)(.*)$/.exec(line);
    if (!m) return line;
    const [, indent, , key, sep, rest] = m;
    if (!isSecretKey(key)) return line;
    if (/^(#|\/\/)/.test(rest.trim()) || rest.trim() === '') return line;
    return `${indent}${m[2]}${key}${m[2]}${sep}${REDACTED}`;
  }).join('\n');
}

/** Recursively replace secret-looking values with '[REDACTED]' in a config
 *  object. Driver-agnostic: covers openclaw/picoclaw/opencode key styles.
 *
 *  Redaction is by SHAPE, not by key name alone — see the two regexes above.
 *  The previous version matched a closed list of exact key names, which shipped
 *  live bearer tokens to every API key with read access: `headers.authorization`
 *  and `headers["X-MCP-Key"]` both missed it while the guide promised they
 *  would not. Arrays, objects and non-string scalars under a secret key are all
 *  redacted, not just strings. */
function redactSecrets(obj, depth = 0) {
  // A depth cutoff must FAIL CLOSED. Returning the value as-is — the previous
  // behaviour — turns "too deep to inspect" into "hand it over untouched",
  // which is the one outcome a redactor must never produce. Past the limit we
  // stop trusting the shape and drop the value; JSON config is a document, not
  // a linked structure, so a legitimate 9-deep nesting is not a thing.
  if (depth > 16) return REDACTED;
  if (Array.isArray(obj)) return obj.map((v) => redactSecrets(v, depth + 1));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (isSecretKey(k)) {
        // An empty/absent value stays absent — "[REDACTED]" on a key that had
        // no value reads as "a secret was here", which is its own lie.
        if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) out[k] = v;
        else out[k] = REDACTED;
      } else {
        out[k] = redactSecrets(v, depth + 1);
      }
    }
    return out;
  }
  // A STRING is a value too. Redacting only by key name let the most likely
  // transcript leak through untouched: an agent runs `cat config.json`, the tool
  // output is one string containing a whole JSON document, and there is no key
  // for the walker to stop at — so `api_key` inside it shipped verbatim. The
  // same line scrub that serves yaml/toml closes that shape, and it only fires
  // on a line that is ALREADY secret-shaped (`token: …`, `API_KEY=…`), so prose
  // merely *discussing* a key is left readable.
  if (typeof obj === 'string') return redactConfigText(obj);
  return obj;
}

/** Driver-aware config read, shared by the REST config route and the MCP
 *  `config_get` tool. JSON configs are parsed + secrets redacted;
 *  yaml/toml/text configs are served verbatim. Returns
 *  `{ config, configRaw, configFormat, configFile }`.
 *
 *  `redact: true` (what the MCP `config_get` tool passes) is the SAFE default
 *  for anything leaving the process: both `config` AND `configRaw` are scrubbed,
 *  because `configRaw` used to be the untouched original text and so a fixed
 *  `config` still leaked through the second field. The REST route
 *  `GET /api/agents/:name/config` deliberately does NOT redact — the web UI's
 *  config editor round-trips `configRaw` back through POST, so redacting it
 *  would write `[REDACTED]` into the user's real config on save. That route is
 *  the operator's own session-authenticated dashboard, not the LLM surface. */
function readAgentConfig(agent, { redact = false } = {}) {
  const driver = getDriver(agent.agent_type);
  const base = { configFormat: driver.configFormat || 'json', configFile: driver.configFile || 'openclaw.json' };
  const configPath = path.join(agent.config_root, base.configFile);
  if (!fs.existsSync(configPath)) return { ...base, config: null, configRaw: null };
  if (base.configFormat !== 'json') {
    const text = fs.readFileSync(configPath, 'utf8');
    // yaml/toml have no parser here, so redaction is a line-level scrub of
    // `key: value` / `key = value` under a secret key name. It is not as
    // thorough as the JSON walk (a secret under a header-style map nested in
    // yaml still slips), but it is strictly better than serving the file
    // verbatim to an LLM — and the REST route below still gets the original.
    return { ...base, config: null, configRaw: redact ? redactConfigText(text) : text, ...(redact ? { redacted: true } : {}) };
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (redact) {
    const safe = redactSecrets(raw);
    return { ...base, config: safe, configRaw: JSON.stringify(safe, null, 2), redacted: true };
  }
  return { ...base, config: redactSecrets(JSON.parse(JSON.stringify(raw))), configRaw: JSON.stringify(raw, null, 2) };
}
