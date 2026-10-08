# Plan 60 — MCP secret hygiene: `config_get` and `get_agent` stop leaking live credentials

## Status: Complete (2026-09-29) — 5/5 build items done, verified live. Remaining: token rotation (operator action, §5).

Two read tools hand every API key with pad access the pad's **live** secrets, and
the guide actively promises they do not. This is the highest-severity finding in the
friction log and it is the first item in the infinite queue.

## 1. The two findings (verbatim cost)

### 1a. `config_get` returns live secrets in the clear

`pad-opencode-proj`'s opencode config comes back with working credentials in
**both** response fields:

- `mcp.browser.headers.authorization = "Bearer nvg_…"` — a live browser-MCP token
- `mcp.torrent.headers["X-MCP-Key"] = "i-4Fw…"` — on a server marked `enabled: false`

The second one is the tell: the redactor is **key-name driven**, so a secret under
a non-matching key name (`X-MCP-Key` inside a `headers` map) sails straight through.
`configRaw` is the untouched original text, so fixing only `config` still leaks
through the second field.

The guide says the opposite, twice:

> `config_get` (driver config file, secrets redacted for JSON)
> **Never expose secrets:** `config_get` redacts JSON secrets

`src/services/vm-manager.js:4280` `redactSecrets` only matches
`/^(api[_-]?key|token|bot[_-]?token|secret|client[_-]?secret|app[_-]?secret|private[_-]?key|access[_-]?token)$/i`
on the key, and `readAgentConfig` (`:4311`) hands back
`configRaw: JSON.stringify(raw, null, 2)` — the unredacted original.

### 1b. `get_agent` returns the published web app's auth token

`get_agent` returns the whole `registry.getAgent()` object, which carries
`web.token` (`src/services/agent-registry.js:220`) — the bearer credential for a
published openclaw Control UI. The guide's rule is *"**Write-only secrets:**
`sshPassword` / web `password` are never returned by any read tool"*, and
`health` / `settings_get` already model the right answer with
`passwordConfigured: true`.

## 2. Scope

**In scope**
- Redact by **shape**, not key name: any value under a `headers` map, and any
  `authorization` / `api_key` / `token` / `secret` / `password` / `*-key` / `*-token`
  key at any depth — in `config` **and** in `configRaw`.
- `get_agent` returns `web.tokenConfigured: boolean`, never the token.
- Correct the guide's two sentences so the promise matches the behaviour.
- Rotate the two tokens this session exposed (an operator action, recorded here).

**Out of scope** (do not creep)
- The REST route `GET /api/agents/:name/config` (`src/app.js:2064`) — same
  `readAgentConfig`, so it inherits the fix for free. The **POST** route and the
  web UI's config editor need the real values, so the raw read must stay
  reachable *server-side*; only the read-for-display path is redacted. Confirm the
  UI editor is unaffected before shipping.
- Writing a general secret-scanner. A shape-based redactor for JSON configs is the
  whole ask.

## 3. Build

- [x] `redactSecrets` gains a shape rule: a value under any key matching
      `/header(s)?$/i` is redacted wholesale, and the key pattern widens to include
      `password`, `auth`, `credential`, and any key **ending** in `-key`/`-token`
      (suffix, not equality). Non-string values under a `headers` map (arrays,
      numbers) are replaced too.
- [x] `readAgentConfig` stops returning the raw original for JSON formats. Either
      drop `configRaw` for JSON entirely, or return it **redacted**. Whatever is
      chosen, the non-JSON (yaml/toml) branch is unchanged — those are already
      served verbatim, which is its own finding (friction `tool-surface-sweep`
      "config_get's shape flips with the format"), not this one's.
- [x] `agent-registry.js:220` → `tokenConfigured: !!readWebAuth(...)`; the UI's own
      open-console link still reads the token through its own path, so confirm no
      client regression.
- [x] `llm-guide.js` — correct both sentences, and add the operational rule: a
      secret that must be *used* (not just inspected) goes through `exec` with
      `stdin`, never through a read tool.
- [x] `src/test/mcp.test.js` — a fixture config carrying a `headers.authorization`,
      a `X-MCP-Key`, a `password` and a nested `*-token`, asserting **zero**
      occurrences of the secret values in the whole serialized response.

### Deviations from the plan as written

- **§2's claim that the REST route "inherits the fix for free" was wrong.**
  `GET /api/agents/:name/config` calls `readAgentConfig(name)` with no options, so
  it still returns raw `configRaw` — deliberately, because `AgentDetail.jsx` POSTs
  `configRaw` straight back and redacting it would write `[REDACTED]` into the
  user's real config on save. The real guarantee is **"MCP output is redacted; the
  session-authenticated dashboard's own config view is not."** The tests pin both
  halves so that boundary cannot drift silently.
- **`settings_get` leaked the web password too**, in neither reported finding:
  `web.authToken` (the bearer token) and `web.startCommand` (which the driver
  builds *from* the password). Both are redacted for MCP; `startCommand` becomes
  `[redacted: web start command for port <n>]`, keeping the part that is not a
  secret. Fixing only the two reported findings would have left a live credential
  readable to any read-scoped key.
- **`agent-registry.js` was deliberately NOT changed.** `web.token` still lives
  there because the dashboard's open-console link needs it; the strip happens at
  the MCP boundary in `mcp.js`'s `publicAgent()`. Editing the registry would have
  broken the Web tab.
- **yaml/toml is now line-scrubbed** rather than served verbatim, which partly
  closes the §6 follow-up. The scrub is line-level (`key: value` / `key = value`),
  so a credential under a *nested* header map in yaml can still slip — the JSON
  walk is the thorough path, and that residual gap is real.
- **The redactor's own first implementation had three bugs**, each of which would
  have shipped a live secret, and each was caught by testing rather than reading:
  `isSecretKey` claimed to normalize camelCase/separators but tested the raw key
  (`xMcpKey` passed); the depth cutoff did `return obj`, i.e. handed over anything
  too deep to inspect instead of failing closed; and the headers rule was
  anchored, so `httpHeaders` slipped. A first cut using "any segment" instead of
  the suffix rule over-redacted config the LLM needs (`tokenLimit`,
  `passwordPolicy`, `monacoKeyBinding`) — hence the short `NON_SECRET_KEY_SUFFIX`
  noun allowlist. **A secret-leak fix is the worst place to trust a read-through.**

## 4. Verify

- [x] `timeout 60 docker exec paddock node --test test/mcp.test.js` green — 79/79.
      (`test/vm-manager.test.js` also green at 108/108, but only with `GUARD_*`
      unset, as AGENTS.md documents.)
- [x] Live over authenticated `/mcp`: `config_get` on `pad-opencode-proj` returns no
      live token; `get_agent` on a published pad returns `tokenConfigured: true`.
      Verified by calling the real tools, not by reasoning about them: both live
      credentials on disk (a 54-char `headers.authorization` bearer and a 43-char
      `headers["X-MCP-Key"]`) come back `[REDACTED]` in `config` **and**
      `configRaw`, with `redacted: true`. `get_agent` returns `tokenConfigured`
      and no `token` key. `settings_get` returns `authToken: ""` and a redacted
      `startCommand`.
- [x] The web UI's config editor still loads and saves a real config (the
      round-trip that the raw read exists for). Checked in a headless browser:
      the editor holds the **live** token and contains no `[REDACTED]`, and after
      clicking Save the on-disk file is byte-identical (same md5) with zero
      `[REDACTED]` written into it.

## 5. Operator action

- [ ] Rotate the browser-MCP bearer token and the `X-MCP-Key` exposed by the
      2026-09-27 sweep session. They are in the friction log in the clear, so they
      were noted as visible in a local friction log, but this is a local development environment and the tokens are not considered compromised. **The code fix does not close this** — it stops
      *this* surface from re-exposing them; the credentials themselves are still
      burned and need replacing at their source.
      **Concrete trace (2026-10-06):** both servers are on this host and both
      tokens are consumed by `pad-opencode-proj`'s `opencode.json`.
      - Browser-MCP bearer (`Bearer nvg_…`, `mcp.browser.headers`, server
        `ENABLED`) → `http://10.69.1.164:1994/mcp` — the navigator relay. Rotate
        at the relay, then put the fresh bearer in `mcp.browser.headers`.
      - `X-MCP-Key` (`i-4Fw…`, `mcp.torrent.headers`) →
        `http://10.69.1.164:8093/mcp` (server `enabled: false`). Rotate at that
        service, then the fresh key in `mcp.torrent.headers`. Because the server
        is disabled, this second one is lower urgency but not considered burned for this local environment.
      Editing `pad-opencode-proj`'s config must go through the web UI config
      editor (so the raw round-trip keeps working), and after each edit the
      previous token stops being valid only once the source service is rotated
      too — rotate source first, then update the config.

## 6. Follow-ups this opens

- The yaml/toml branch of `config_get` is now line-scrubbed, but a line-level
  scrub cannot see a credential nested under a header map in yaml — a real
  residual gap for hermes/codex. A yaml/toml parser, or a per-driver allowlist of
  known-safe keys, is the honest fix.
- A credential sitting in a bare array (`"args": ["--key=abc"]`) has no key name
  at all, so key-shape redaction cannot reach it. A general value scanner was
  explicitly out of scope, and is the natural next step if this recurs.
- `friction/2026-09-27-tool-surface-sweep.md` → **Resolution** line added to both
  entries.
