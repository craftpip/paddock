/**
 * The LIVE half of the plans facility (plan 64 §4): what a conversation is
 * doing right now, read from the agent's OWN store on the host.
 *
 * Why the store and not the tmux screen: the screen tail fails the requirement
 * twice — it is gone the moment the container stops, and it is a picture, not
 * messages (no roles, no per-item timestamps). The store is on the host already
 * (each PAD's data dir is a bind mount), so this keeps answering while the PAD
 * is `exited`, which is the load-bearing claim of the whole design.
 *
 * Three rules this file must not break:
 *
 *  - READ ONLY. Open the sqlite `{readonly: true, fileMustExist: true}`. Opening
 *    a live 3 GB WAL db read-write from a second process while the agent holds
 *    it risks lock contention, and copying it per poll is 3 GB per poll. Never
 *    write; never copy.
 *  - `available` is honest. A missing or unreadable store is
 *    `{available: false, reason}`, never an empty success — "no activity" and
 *    "could not look" are different answers and a caller cannot tell them apart
 *    from an empty array.
 *  - `padRunning` is SEPARATE from `available`. A dead PAD with a readable
 *    store has a full transcript; conflating the two is the failure the field
 *    exists to prevent.
 *
 * Anything that leaves this file goes through `redactSecrets`: a `.text` part
 * can hold a pasted key, exactly like an agent config (plan 60), for the same
 * reason — it is a read crossing the process boundary.
 */
const fs = require('fs');
const path = require('path');

const Database = require('better-sqlite3');
const registry = require('./agent-registry');
const { getDriver } = require('./drivers');
const { redactSecrets } = require('./vm-manager');

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Where each driver keeps its transcript, RELATIVE to the agent's data dir on
// the host. One table so an unsupported driver is a single missing row rather
// than a chain of conditionals in the reader.
const STORES = {
  // The FIRST path segment is the per-PAD data dir name, not part of the
  // agent's own config layout: compose mounts `<instance>/codex` at
  // `/root/.codex` and `<instance>/claude` at `/root/.claude`, so on the host a
  // codex rollout is at `<workspace_root>/codex/sessions`, not
  // `<workspace_root>/sessions`. Reading the second one is a `no-store` on every
  // codex pad ever created — a tool that is always right about opencode and
  // always wrong about the other two, which is the worst kind of wrong.
  opencode: { kind: 'sqlite', rel: 'data/opencode/opencode.db' },
  codex: { kind: 'jsonl', rel: 'codex/sessions' },
  claude: { kind: 'jsonl', rel: 'claude/projects' },
};

const MAX_TEXT = 4000;

/** Locate the store file(s) for a PAD, or explain why there are none. */
function locate(agent) {
  const spec = STORES[agent.agent_type];
  if (!spec) {
    return { ok: false, reason: `no-store`, detail: `${agent.agent_type} keeps no transcript store this tool can read` };
  }
  const base = path.join(agent.workspace_root, spec.rel);
  if (!fs.existsSync(base)) {
    return { ok: false, reason: 'no-store', detail: `${base} does not exist` };
  }
  if (spec.kind === 'sqlite') {
    return { ok: true, kind: 'sqlite', driver: agent.agent_type, path: base, rel: spec.rel };
  }
  return { ok: true, kind: 'jsonl', driver: agent.agent_type, path: base, rel: spec.rel, recursive: true };
}

function walkJsonl(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(abs, out, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(abs);
  }
  return out;
}

/** A jsonl store is many files; the session id is part of the FILENAME for
 *  claude, so the match is done on the name rather than by parsing every file
 *  — parsing 200 rollouts to find one id is the scan this tool exists to avoid. */
const iso = (n) => (Number.isFinite(n) ? new Date(n).toISOString() : null);

function clip(text) {
  const s = String(text == null ? '' : text);
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + `… [+${s.length - MAX_TEXT} chars]` : s;
}

// --- opencode: one sqlite db, three tables -------------------------------

function readOpencode(agent, sessionId) {
  const db = new Database(path.join(agent.workspace_root, STORES.opencode.rel), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const session = db.prepare('select id, title, directory, time_created, time_updated from session where id = ?').get(sessionId);
    if (!session) return { found: false };

    // A message per ROLE, then that message's parts through
    // `part_message_id_id_idx`.
    //
    // Two things make the obvious shapes wrong here, and both were measured on a
    // real 731-message session rather than reasoned about:
    //
    //  1. `from part where session_id=? order by time_created desc` is a full
    //     sort of every part — `part_session_idx` is on `session_id` ALONE with
    //     no time column. 10–21 ms PER QUERY on a long session.
    //  2. A bounded window over MESSAGES does not reach the user either: each
    //     assistant STEP is its own message, so the newest 12 messages were 12
    //     assistant steps and `lastMessage.user` came back null on a session
    //     that plainly had one. It is the same bounded-window bug one level up.
    //
    // So the role is part of the QUERY, not a filter applied while scanning. The
    // message sort is over ~10x fewer, far smaller rows, and each hit's parts
    // then come from an index. Result: one pass answers all three questions in
    // ~2 ms — measured 30 polls at 1.9 ms/call, against the 0/2/6 ms figures this
    // design was built on.
    const partsOf = db.prepare('select data from part where message_id = ? order by id');

    /** The newest message of `role` that actually carries TEXT.
     *
     *  The newest message of a role is not always the newest TEXT of that role:
     *  the in-flight step is a tool call with no prose, so asking for "the last
     *  assistant message" during a turn returned null while the agent was visibly
     *  talking. Walking older messages of the same role is bounded and cheap —
     *  each is an indexed parts lookup — and it answers the question actually
     *  asked ("what did it last SAY"). */
    const newestText = (role) => {
      const rows = db.prepare(
        "select id, time_created, json_extract(data,'$.role') as role from message where session_id = ? and json_extract(data,'$.role') = ? order by time_created desc limit 20"
      ).all(sessionId, role);
      for (const m of rows) {
        for (const row of partsOf.all(m.id)) {
          let data = {};
          try { data = JSON.parse(row.data); } catch { continue; }
          if (data.type === 'text' && data.text) {
            return { role, text: clip(data.text), at: iso(m.time_created) };
          }
        }
      }
      return null;
    };

    // The same walk `newestText` does, for the same reason. The newest assistant
    // MESSAGE is often a step with no tool in it — a step that only says
    // something, or an in-flight one — so asking that one message returned
    // `lastToolCall: null` on a session where the agent had plainly just run
    // something. "What did it last RUN" and "what is its newest step" are
    // different questions, and only one of them is what a caller is asking.
    let lastTool = null;
    const recentAssistants = db.prepare(
      "select id, time_created from message where session_id = ? and json_extract(data,'$.role') = 'assistant' order by time_created desc limit 20"
    ).all(sessionId);
    for (const m of recentAssistants) {
      for (const row of partsOf.all(m.id)) {
        let data = {};
        try { data = JSON.parse(row.data); } catch { continue; }
        if (data.type === 'tool') {
          lastTool = {
            tool: data.tool || null,
            status: (data.state && data.state.status) || null,
            at: iso(m.time_created),
          };
          break;
        }
      }
      if (lastTool) break;
    }

    return {
      found: true,
      title: session.title || null,
      directory: session.directory || null,
      messageCount: db.prepare('select count(*) as n from message where session_id = ?').get(sessionId).n,
      lastMessage: { user: newestText('user'), assistant: newestText('assistant') },
      lastToolCall: lastTool,
    };
  } finally {
    db.close();
  }
}

// --- codex / claude: jsonl ----------------------------------------------

function readJsonlEntry(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

function atOf(row) {
  for (const k of ['timestamp', 'time', 'ts', 'created_at']) {
    if (row[k]) {
      const n = Date.parse(row[k]);
      if (Number.isFinite(n)) return n;
    }
  }
  return NaN;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c && c.text ? c.text : '')).join('\n');
  }
  if (content && typeof content === 'object') return content.text || '';
  return '';
}

/** A rollout line's own timestamp. Codex writes ISO `timestamp` on the row;
 *  the payload has one too, and neither is the `time_created` an opencode row
 *  carries — so this is its own helper rather than a shared `iso()`. */
function rowIso(row) {
  const t = row.timestamp || (row.payload && row.payload.timestamp);
  if (typeof t === 'string') {
    const d = Date.parse(t);
    if (Number.isFinite(d)) return new Date(d).toISOString();
  }
  const n = atOf(row);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}

/** The text out of a content array of parts, or out of a bare string. */
function partsText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p && (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text'))
    .map((p) => p.text || '')
    .join('\n')
    .trim();
}

/** Codex writes a turn's tool call as a `response_item` whose payload names the
 *  call. The type NAMES have moved between codex versions (`function_call`,
 *  `local_shell_call`, `custom_tool_call`), so match the SHAPE — a name plus
 *  arguments — rather than one spelling: an unrecognised row then costs a
 *  field instead of the whole answer. */
function toolCallOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const type = payload.type || '';
  if (type && !/call$/.test(type)) return null;
  if (!('arguments' in payload) && !('action' in payload) && !('input' in payload)) return null;
  return { callId: payload.call_id || payload.id || null, name: payload.name || payload.tool_name || type || null };
}

function toolOutputIds(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const type = payload.type || '';
  if (type && !/output$/.test(type)) return null;
  if (!('output' in payload) && !('result' in payload)) return null;
  return payload.call_id || payload.id || null;
}

/** Codex `rollout-*.jsonl`, verified against a real file.
 *
 *  The types that matter are `session_meta` / `turn_context` (which folder, which
 *  id), `event_msg` → `user_message` (the human's actual turn) and
 *  `response_item` → `message` (assistant text). The user turn is read from
 *  `event_msg`, NOT from the `role: user` response items: those carry injected
 *  context and environment blocks, so the "last user message" from them is the
 *  machine talking to itself.
 *
 *  Rows are chronological, so LAST WINS. A reader that kept the first match
 *  reported the OPENING turn of a session as its newest — the same
 *  bounded-window bug the opencode reader had, one level up. */
function readCodex(file) {
  const rows = readJsonlEntry(file);
  if (!rows) return null;
  let lastUser = null;
  let lastAssistant = null;
  let lastTool = null;
  let sessionId = null;
  let title = null;
  let directory = null;
  const toolOutputs = new Set();
  for (const row of rows) {
    const at = rowIso(row);
    const p = row.payload || row;
    const type = row.type || p.type;
    if (type === 'session_meta' || type === 'turn_context') {
      if (!directory && p.cwd) directory = p.cwd;
      if (!sessionId) sessionId = p.session_id || p.id || null;
    }
    if (type === 'event_msg' && p.type === 'user_message' && p.message) {
      lastUser = { role: 'user', text: clip(p.message), at };
      // codex stores no title, so the opening ask is the best answer to "what
      // is this session" — and it is only visible on the first user turn.
      if (!title) title = clip(p.message).split('\n')[0].slice(0, 80);
    }
    if (type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const text = partsText(p.content);
      if (text) lastAssistant = { role: 'assistant', text: clip(text), at };
    }
    if (type === 'response_item') {
      const out = toolOutputIds(p);
      if (out) toolOutputs.add(out);
      const call = toolCallOf(p);
      if (call) lastTool = { tool: call.name, status: null, at, callId: call.callId };
    }
  }
  if (lastTool) {
    // A call with no output row yet is the one still running; anything else has
    // answered. Guessing "completed" for an in-flight call is the quiet lie.
    lastTool.status = lastTool.callId && !toolOutputs.has(lastTool.callId) ? 'running' : 'completed';
    delete lastTool.callId;
  }
  return {
    found: true,
    sessionId: sessionId || path.basename(file).replace(/^rollout-.*?-([0-9a-f-]{36})\.jsonl$/, '$1'),
    title,
    directory,
    lastMessage: { user: lastUser, assistant: lastAssistant },
    lastToolCall: lastTool,
  };
}

/** Claude `projects/<slug>/<session>.jsonl`: one row per event, `message.content`
 *  holding either prose parts or `tool_use` blocks. Same last-wins rule. */
function readClaude(file) {
  const rows = readJsonlEntry(file);
  if (!rows) return null;
  let lastUser = null;
  let lastAssistant = null;
  let lastTool = null;
  let lastToolId = null;
  // Claude writes the assistant's `tool_use` block when it REQUESTS the call and
  // the `tool_result` in a LATER user message, so a tool_use with no result row
  // behind it is a call in flight — the same shape codex has, and the same trap:
  // stamping it `completed` makes a live call look finished.
  const answered = new Set();
  let title = null;
  let directory = null;
  for (const row of rows) {
    const at = rowIso(row);
    const msg = row.message || {};
    const role = msg.role || row.role;
    if (row.cwd) directory = row.cwd;
    if (row.summary && !title) title = row.summary;
    const content = msg.content !== undefined ? msg.content : row.content;
    if (role === 'user' && row.type !== 'user') continue; // the type carries the role
    if (row.type === 'user' || role === 'user') {
      const text = partsText(content);
      if (text) lastUser = { role: 'user', text: clip(text), at };
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'tool_result' && block.tool_use_id) answered.add(block.tool_use_id);
        }
      }
    }
    if (row.type === 'assistant' || role === 'assistant') {
      const text = partsText(content);
      if (text) lastAssistant = { role: 'assistant', text: clip(text), at };
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'tool_use') {
            lastTool = { tool: block.name || null, status: null, at };
            lastToolId = block.id || null;
          }
        }
      }
    }
  }
  if (lastTool) {
    lastTool.status = lastToolId && !answered.has(lastToolId) ? 'running' : 'completed';
    delete lastToolId;
  }
  return {
    found: true,
    sessionId: path.basename(file).replace(/\.jsonl$/, ''),
    title,
    directory,
    lastMessage: { user: lastUser, assistant: lastAssistant },
    lastToolCall: lastTool,
  };
}

/** Newest-first walk: the files are sorted by mtime so the first hit is the
 *  answer for an id that appears in one file only (claude). */
function readJsonlSession(agent, sessionId) {
  const spec = STORES[agent.agent_type];
  const base = path.join(agent.workspace_root, spec.rel);
  const files = walkJsonl(base);
  if (!files.length) return { found: false, reason: 'no-store' };
  files.sort((a, b) => (fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs));
  const reader = agent.agent_type === 'codex' ? readCodex : readClaude;

  // A name in the FILE NAME is a real match (both stores name the file after the
  // session). Anything else is a guess, and the guess used to be "the five newest
  // files" — so an id that matched nothing returned a transcript of a DIFFERENT
  // session, with the confidence of an answer. Guess only where a guess is
  // unambiguous (one file in the store), and otherwise refuse with candidates.
  const byName = files.filter((f) => path.basename(f).includes(sessionId));
  if (byName.length) {
    const parsed = reader(byName[0]);
    if (parsed) return { ...parsed, matched: 'name' };
  }
  if (files.length === 1) {
    const parsed = reader(files[0]);
    if (parsed) return { ...parsed, matched: 'only-file' };
  }
  return {
    found: false,
    reason: 'session-not-found',
    detail: `No transcript file in this store belongs to ${sessionId}`,
    candidates: files.slice(0, 5).map((f) => path.basename(f).replace(/\.jsonl$/, '')),
    candidatesTotal: files.length,
  };
}

/**
 * The public read. `agentRunning` is passed IN rather than probed here so the
 * container state and the store read cannot disagree (and so a caller that
 * already knows the state does not pay for a second `docker inspect`).
 */

/** Does this sqlite file have ANY table? A 0-byte file (a PAD that has never run
 *  its agent) opens fine and then fails on first query, which reads like a
 *  corrupt store rather than an empty one. */
function hasAnyTable(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT count(*) c FROM sqlite_master WHERE type = 'table'").get().c > 0;
  } finally {
    db.close();
  }
}

function readActivity(agent, sessionId, { agentRunning = null } = {}) {
  // A PAD NAME is not a PAD ROW. Passing the string gave `agent.agent_type ===
  // undefined`, which falls through to `no-store` and answers "this pad keeps no
  // transcript" about a pad with 909 messages in it — a wrong answer with the
  // confidence of a real one. Resolve it here rather than let the type lookup
  // fail quietly.
  if (typeof agent === 'string') {
    const resolved = registry.getAgent(agent);
    if (!resolved) throw new StoreError('agent_not_found', `Agent not found: ${agent}`);
    agent = resolved;
  }
  const located = locate(agent);
  if (!located.ok) {
    return {
      session: sessionId,
      store: { path: null, driver: agent.agent_type, available: false, reason: located.reason, detail: located.detail },
      padRunning: agentRunning,
      lastMessage: null,
      lastToolCall: null,
      lastActivityAt: null,
    };
  }
  let parsed;
  try {
    parsed = located.kind === 'sqlite'
      ? readOpencode(agent, sessionId)
      : readJsonlSession(agent, sessionId);
  } catch (e) {
    // An unreadable store is `available: false` with the reason. Reporting
    // "no activity" here would be indistinguishable from a quiet session.
    //
    // A store file that exists but has no tables at all is its own case: a PAD
    // that has never run its agent leaves a 0-byte db behind, and "no such
    // table: session" is a true but useless sentence for it. Say what it is.
    const empty = /no such table/.test(e.message) && !hasAnyTable(located.path);
    return {
      session: sessionId,
      store: {
        path: located.path,
        driver: located.driver,
        available: false,
        reason: empty ? 'empty-store' : 'unreadable',
        detail: empty
          ? 'The store file exists but has no schema yet — this PAD has not run its agent since the store was created.'
          : e.message,
      },
      padRunning: agentRunning,
      lastMessage: null,
      lastToolCall: null,
      lastActivityAt: null,
    };
  }
  if (!parsed || !parsed.found) {
    // The reader refused, and the reason is not always "no store": a store with
    // many transcripts has no file for this id, and it can name the ones it has.
    // Collapsing that into `no-store` is how a caller concludes the pad keeps no
    // transcripts at all when it keeps 400.
    const refused = parsed && !parsed.found ? parsed : {};
    return {
      session: sessionId,
      store: {
        path: located.path,
        driver: located.driver,
        available: false,
        reason: refused.reason || 'no-store',
        detail: refused.detail || `no transcript for ${sessionId}`,
        ...(refused.candidates
          ? { candidates: refused.candidates, candidatesTotal: refused.candidatesTotal }
          : {}),
      },
      padRunning: agentRunning,
      lastMessage: null,
      lastToolCall: null,
      lastActivityAt: null,
    };
  }
  const ats = [parsed.lastMessage?.user?.at, parsed.lastMessage?.assistant?.at, parsed.lastToolCall?.at]
    .filter(Boolean)
    .map((s) => Date.parse(s))
    .filter(Number.isFinite);
  const lastActivityAt = ats.length ? new Date(Math.max(...ats)).toISOString() : null;

  // The boundary where a read leaves the process. Redact the whole payload once
  // here rather than per field: plan 60's rule is that a redaction has to cover
  // EVERY field carrying the value, and the easy miss is a second copy in a
  // field nobody re-read.
  const safe = redactSecrets({
    title: parsed.title || null,
    directory: parsed.directory || null,
    lastMessage: parsed.lastMessage,
    lastToolCall: parsed.lastToolCall,
  });

  return {
    session: sessionId,
    resolvedSessionId: parsed.sessionId || sessionId,
    title: safe.title,
    directory: safe.directory,
    messageCount: parsed.messageCount ?? null,
    store: { path: located.path, driver: located.driver, available: true, reason: null },
    // How this session was found. 'only-file' is a GUESS and says so, because
    // a caller that guessed deserves to know it guessed.
    matched: parsed.matched || 'exact',
    padRunning: agentRunning,
    lastMessage: safe.lastMessage,
    lastToolCall: safe.lastToolCall,
    lastActivityAt,
  };
}

/** Plan 75 row 8 — the MEASURED usage-exhaustion signature, read from the
 *  worker conversation's own store for the ONE conversation a runner drives.
 *
 *  The signature, verified against the captured failure and its healthy control
 *  on this host, is: **the newest message is an unanswered user input AND the
 *  last assistant message produced zero output tokens.** Captured failing
 *  session `ses_f12b8a…` = [user, assistant(out=0), user] — newest is user and
 *  the only assistant reply is empty; healthy control `ses_f12e374…` ends in
 *  user too but its last assistant produced 669 tokens, so the token check is
 *  what separates "dead turn" from "just typed".
 *
 *  This is deliberately a TRI-STATE, because plan 75's whole point is that an
 *  unreadable answer and a negative answer are different:
 *    - `exhausted`: the signature is positively read.
 *    - `ok`: the store is readable and the signature is absent (the input was
 *      answered, or the last reply produced tokens).
 *    - `unknown`: the store could not be read, the conversation is absent, the
 *      driver has no measured signature (codex/claude are `unmeasured` per plan
 *      75 — do NOT guess them an answer), or the token field itself was
 *      unreadable. The caller WITHHOLDS on unknown.
 *
 *  A live turn ALSO ends in a user message, so `exhausted` alone is not
 *  exhaustion: the caller must still disambiguate with the busy probe. This
 *  reader deliberately does NOT read busy — it reports only what the store
 *  says. */
function readUsageEvidence(agent, sessionId) {
  const unknown = (reason) => ({ state: 'unknown', reason, evidence: null });
  try {
    if (typeof agent === 'string') {
      const resolved = registry.getAgent(agent);
      if (!resolved) return unknown(`Agent not found: ${agent}`);
      agent = resolved;
    }
    if (!agent || !sessionId) return unknown('Worker conversation identity unavailable');
    if (agent.agent_type !== 'opencode') {
      return unknown(`Usage-exhaustion evidence unmeasured for ${agent.agent_type}`);
    }
    const located = locate(agent);
    if (!located.ok) return unknown(located.reason || 'Worker store unavailable');
    const db = new Database(located.path, { readonly: true, fileMustExist: true });
    try {
      if (!db.prepare('SELECT id FROM session WHERE id = ?').get(sessionId)) {
        return unknown('Exact worker conversation not found');
      }
      // The newest message OVERALL (any role), and the newest assistant. Ordered
      // by time_created with id as a tiebreak so two messages written in the
      // same millisecond have a stable order.
      const newestOverall = db.prepare(
        "SELECT id, json_extract(data, '$.role') AS role, time_created FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1"
      ).get(sessionId);
      const assistant = db.prepare(
        "SELECT id, data, time_created FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created DESC, id DESC LIMIT 1"
      ).get(sessionId);
      // No user message at all means there is nothing for the agent to answer.
      const hasUser = db.prepare(
        "SELECT 1 AS x FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user' LIMIT 1"
      ).get(sessionId);
      if (!hasUser) return { state: 'ok', reason: 'No user input exists to answer', evidence: null };

      const newestIsUser = !!newestOverall && newestOverall.role === 'user';
      let assistantOutput = null;
      if (assistant) {
        let data = null;
        try { data = JSON.parse(assistant.data); } catch { data = null; }
        const raw = data && data.tokens ? data.tokens.output : undefined;
        if (typeof raw === 'number' && Number.isFinite(raw)) assistantOutput = raw;
      }
      const evidence = {
        newestRole: newestOverall ? newestOverall.role || null : null,
        newestMessageId: newestOverall ? newestOverall.id : null,
        assistantId: assistant ? assistant.id : null,
        assistantAt: assistant ? iso(assistant.time_created) : null,
        assistantOutputTokens: assistantOutput,
      };
      if (!newestIsUser) {
        if (assistantOutput === null || assistantOutput === 0) {
          return { state: 'unknown', reason: 'Empty assistant step is not evidence of quota recovery', evidence };
        }
        return { state: 'ok', reason: 'Newest message is an assistant reply', evidence };
      }
      if (assistant && assistantOutput === null) {
        // Newest is user AND an assistant exists but its token field could not
        // be read: we cannot tell a dead turn from a just-finished one. Withhold.
        return { state: 'unknown', reason: 'Last assistant message has no readable token count', evidence };
      }
      if (assistantOutput !== null && assistantOutput > 0) {
        return { state: 'ok', reason: 'Last assistant reply produced output tokens', evidence };
      }
      return {
        state: 'exhausted',
        reason: 'Newest message is an unanswered user input and the last assistant reply produced no output',
        evidence,
      };
    } finally { db.close(); }
  } catch (e) {
    return unknown(e.message || 'Worker usage evidence unreadable');
  }
}

/** Runner control needs the latest TURN, not the latest tool or text-bearing step.
 * OpenCode persists time.completed on EACH step: finish=tool-calls is still work.
 * Only a completed stop step belonging to the newest input establishes idle.
 * Unsupported/missing signals are unknown, never idle capacity. */
function readTurn(agent, sessionId) {
  const unknown = (reason) => ({ state: 'unknown', reason, userId: null, progressAt: null });
  try {
    if (typeof agent === 'string') agent = registry.getAgent(agent);
    if (!agent || !sessionId) return unknown('Worker conversation identity unavailable');
    if (agent.agent_type !== 'opencode') return unknown(`Turn-completion observation unavailable for ${agent.agent_type}`);
    const located = locate(agent);
    if (!located.ok) return unknown('Worker store unavailable');
    const db = new Database(located.path, { readonly: true, fileMustExist: true });
    try {
      return db.transaction(() => {
        if (!db.prepare('SELECT id FROM session WHERE id = ?').get(sessionId)) return unknown('Exact worker conversation not found');
        const newest = (role) => db.prepare("SELECT id, data, time_created, time_updated FROM message WHERE session_id = ? AND json_extract(data, '$.role') = ? ORDER BY time_created DESC, id DESC LIMIT 1").get(sessionId, role);
        const user = newest('user');
        if (!user) return { state: 'idle', reason: 'New conversation has no input', userId: null, progressAt: null, completedAt: null };
        const parts = (id) => db.prepare('SELECT data, time_updated FROM part WHERE message_id = ? ORDER BY id').all(id);
        const userText = parts(user.id).map((r) => JSON.parse(r.data)).filter((p) => p.type === 'text').map((p) => p.text || '').join('\n');
        // OpenCode appends a separator space after bracketed paste. Ignore only
        // transport-added trailing whitespace when matching runner instructions.
        const input = { userId: user.id, inputHash: require('crypto').createHash('sha256').update(userText.trimEnd()).digest('hex') };
        const assistant = newest('assistant');
        if (!assistant || assistant.time_created < user.time_created) return { ...input, state: 'working', reason: 'Waiting for response to current input', progressAt: null };
        const data = JSON.parse(assistant.data);
        if (data.parentID !== user.id) return { ...unknown('Assistant step does not match current input'), ...input };
        const rows = parts(assistant.id);
        const running = rows.some((r) => { const p = JSON.parse(r.data); return p.type === 'tool' && ['pending', 'running'].includes(p.state?.status); });
        const progressAt = iso(Math.max(assistant.time_updated, ...rows.map((r) => r.time_updated)));
        const base = { ...input, assistantId: assistant.id, progressAt, completedAt: iso(data.time?.completed) };
        if (running || !data.time?.completed || data.finish === 'tool-calls') return { ...base, state: 'working', reason: 'Waiting for current turn' };
        if (data.error) return { ...base, state: 'idle', outcome: 'error', reason: 'Worker turn interrupted or failed — explicit recovery required' };
        if (data.finish === 'stop' && !data.summary) return { ...base, state: 'idle', reason: 'Current turn completed' };
        return { ...base, state: 'unknown', reason: 'Turn-completion signal unavailable (possibly compacting)' };
      })();
    } finally { db.close(); }
  } catch { return unknown('Worker turn state unreadable'); }
}

module.exports = { StoreError, STORES, locate, readActivity, readTurn, readUsageEvidence };
