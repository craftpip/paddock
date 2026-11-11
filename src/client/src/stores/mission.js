import { create } from 'zustand'
import { api } from '../lib/api'

// Mission (plan 53) — projects are (agent, folder) pairs; a session is the only
// unit of work. This store owns col 1 (the projects), col 2 (the sessions) and
// the folder probe the create/edit dialog needs.
//
// "Sessions" is two different things, and conflating them was the trap: the
// `sessions` below are LIVE tmux sessions Mission opened (a row you can type
// into), while `history` is the agent's own past conversations, read from its
// store (opencode.db / codex rollouts / claude jsonl) and scoped to the project
// folder. An agent that has been chatted with for months has history long
// before Mission existed, and a project pointing at that folder must show it —
// otherwise the page claims you have no work where you have 9 conversations.
// Resuming a history row opens it as a live session.
//
// The backend is the authority on every rule here (coding-models only, running
// PADs only, absolute container paths). The store's job is to call it and hold
// what came back — including the `code`, so the dialog can explain a refusal
// instead of showing a bare string.

function errText(e, fallback = 'Something went wrong') {
  return e?.message || e?.error || fallback
}

// Every queue endpoint answers with the envelope `{ runner, project, queue,
// updatedAt }` (plan 86 §Phase 1); the panel renders the inner `queue`. Accept a
// bare queue object too, so the store is not coupled to the envelope's wrapper.
function queueOf(data) {
  return data && typeof data === 'object' && data.queue ? data.queue : data
}

/* Idea 2 (plan 68): a refresh keeps the page state. Column widths and the
 * folded state already persist; what reset were the three things that LIVE in
 * this store — the selected project, the highlighted session, and the open
 * conversation. So they persist here, as one JSON blob under a key of their
 * own, written on every change and read back when the store is created.
 *
 * Node (the test runner) has no localStorage; every touch is guarded. The
 * guard is `typeof`, not a `try` alone: the WRITE path also needs the catch
 * because localStorage can throw in privacy modes, but the READ path must not
 * abort the store over a corrupt blob either. */
const PERSIST_KEY = 'pad-mission-view'

function readPersistedView() {
  if (typeof localStorage === 'undefined') {
    // Same SHAPE regardless of environment: the store's initial `openSession`
    // must be `null`, never `undefined` — the persist writer serializes
    // `undefined` as an ABSENT key, and an absent key round-trips to
    // `undefined` again, so the blob would never carry `openSession`.
    return { selectedProjectId: '', selectedConversationId: '', openSession: null }
  }
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return { selectedProjectId: '', selectedConversationId: '', openSession: null }
    const v = JSON.parse(raw)
    return {
      selectedProjectId: typeof v.selectedProjectId === 'string' ? v.selectedProjectId : '',
      // Renamed from `selectedSessionId` (plan 80): the highlight is a
      // CONVERSATION now, not the mission row, so closing a pane no longer
      // drops it. An old blob has no `selectedConversationId`, so fall back to
      // the open snapshot's conversation id (present on new blobs) so the
      // highlight survives one reload, then `''`.
      selectedConversationId:
        typeof v.selectedConversationId === 'string'
          ? v.selectedConversationId
          : (v.openSession && typeof v.openSession.agentSessionId === 'string' ? v.openSession.agentSessionId : ''),
      openSession: v.openSession || null,
    }
  } catch {
    return { selectedProjectId: '', selectedConversationId: '', openSession: null }
  }
}

function writePersistedView(s) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        selectedProjectId: s.selectedProjectId,
        selectedConversationId: s.selectedConversationId,
        openSession: s.openSession,
      })
    )
  } catch {
    /* privacy mode / quota — persistence is best-effort */
  }
}

/** "Which conversation is highlighted" — and the ONLY rule is that a DATA FETCH
 *  never moves it. Every `fetchSessions` / aggregate `fetchAll` success spreads
 *  this, so it MUST NOT pick a row: the old `rows.find(live) || rows[0]`
 *  fallback invented a highlight for a page the user had opened nothing on
 *  (plan 73's phantom `msn-row-selected`), and now that the highlight is a
 *  CONVERSATION it would also resurrect a highlight the user never chose.
 *
 *  The selection is written by exactly two user actions (click a row, start a
 *  session) and cleared only when the list it belongs to is replaced
 *  (`select` / `createProject` / `deleteProject`). It deliberately survives a
 *  refresh — and, the whole point of plan 80, a CLOSE: closing the pane removes
 *  the pane, not the conversation, so the row stays highlighted. */
function followSessionPatch(_rows, currentId) {
  return { selectedConversationId: currentId || '' }
}

/** A frozen copy of the row that was opened, plus enough of its project for col
 *  3 to render without asking the project list.
 *
 *  This is what col 3 renders from, and it exists because a column that is
 *  refetched must not be what the next column renders from (plan 58 item 1).
 *  Col 2's list is cleared and refetched on a scope switch, on a project click,
 *  on every 15s poll and after every action; while the terminal derived its
 *  session from that array, each of those emptied col 3 for ~200ms, `<Terminal>`
 *  unmounted, the WebSocket closed and a fresh xterm + tmux attach was built for
 *  a conversation the user never let go of. The snapshot is written by exactly
 *  two user actions (open a row, start a session) and cleared by exactly one
 *  (close that session), so nothing else can move col 3.
 *
 *  `agentName` / `folder` are copied rather than looked up because a project
 *  deleted from col 1 must not blank the conversation that is still open: the
 *  session really is dead then, and col 3 says so in its own words. */
function snapshotOf(row, projects) {
  if (!row) return null
  const project = row.project || projects.find((p) => p.id === row.project_id) || null
  return {
    id: row.id,
    tmux_id: row.tmux_id,
    label: row.label || '',
    // The agent's own title for the conversation (plan 80) — stamped by the
    // list read when it could read the store, else refreshed from the detail
    // read. Col 3's header shows it before the tmux id, exactly like a row.
    title: row.title || '',
    // The conversation this pane is on. It is the ROW's identity now: the
    // selection is keyed on it so a live row and its history twin are one item.
    agentSessionId: row.agent_session_id || '',
    locked: !!row.locked,
    live: row.live,
    projectId: row.project?.id || project?.id || '',
    projectName: row.project?.name || project?.name || '',
    agentName: row.project?.agent_name || project?.agent_name || '',
    folder: row.project?.folder || project?.folder || '',
  }
}

// Counts the starts that have been issued. `startSession` is allowed to run two
// at once (a second row clicked while the first is still opening), so the older
// one can resolve last — it must then leave the newer one's selection and busy
// state alone. Module scope on purpose: it is per page load, not per component.
let startToken = 0
// Guards the runner listing against out-of-order fetches: a project response
// that lands after a scope switch must not overwrite the new scope's rows.
let runnerToken = 0
// Guards the open runner's QUEUE read (plan 86 §Phase 2): the queue must follow
// col 3, so when the open session changes while a read is in flight the stale
// answer must not become the new conversation's queue. Module scope like the
// other tokens — per page load, not per component.
let queueToken = 0
let viewToken = 0
let listToken = 0
let historyToken = 0
let projectToken = 0
let paneToken = 0
// session id → when its open action asked for an automatic reopen. Honoured by
// the first pane read that lands for that session within a few seconds, then
// forgotten: the periodic poll must never inherit it (it never restarts a
// dead session on its own).
const pendingAutoReopen = new Map()
const AUTO_REOPEN_WINDOW_MS = 5000

export const useMission = create((set, get) => {
  // Idea 2 (plan 68) hydrate: read the persisted view ONCE at store creation.
  // Empty in node (no localStorage) and on a first visit.
  const restored = readPersistedView()
  return {
  projects: [],
  loading: true,
  error: '',
  // Runners (plan 83, merged listing plan 85)
  runners: [],
  runnersFor: '',
  runnersLoading: false,
  runnersError: '',
  // The OPEN session's queue (plan 86 §Phase 2). `queueForRunner` is the runner
  // the snapshot belongs to, so a snapshot taken for one conversation is never
  // rendered under another. `queueStale` means the snapshot survived a FAILED
  // refresh — it is the last known good and the panel says so, rather than
  // claiming the current state. `queueAction` names the running mutation so
  // setup and update are busy individually instead of a shared global.
queue: null,
   queueForRunner: '',
   queueLoading: false,
   queueError: '',
   queueStale: false,
   queueAction: '',
   // Centralized feedback for queue operations (plan 98 §Phase 1).
   // Keyed by runnerId; holds the latest operation feedback for the queue panel.
   // Cleared on successful recovery, retained for dismissal by user.
   operationFeedback: {},
  // `''` = no selection = the ALL-projects view. A project id = that project's
  // view. There is no third state (plan 68 removed `scope`): what col 2 shows
  // is derived from this one field, so a selection change can never leave the
  // column showing a list from the other scope.
   selectedProjectId: '',
   persistedView: restored,
   navigateView: null,
   viewLoading: false,
   viewError: '',
   viewUnavailable: false,
   historyView: null,
  // Live tmux sessions of the selected project, and the agent's own history in
  // its folder.
  sessions: [],
  sessionsLoading: false,
  sessionsError: '',
  history: null,
  historyLoading: false,
  historyError: '',
  includeSubfolders: false,
  // True once the aggregate read succeeded — the placeholder must not show on a
  // refresh, and must still show on a first load (same rule as `loadedFor`).
  allLoading: false,
  allError: '',
  allLoaded: false,
  // Which projects the aggregated history read failed for. Reported in the
  // column's error BAR, never as rows inside the list (plan 68 Idea 6): one
  // stopped PAD must not hide the others, and a probe failure is not a
  // conversation.
  historyErrors: [],
   selectedConversationId: '',
  // The conversation col 3 is showing — a snapshot taken when it was opened, NOT
  // derived from `sessions`. See `snapshotOf`: this is what keeps a scope switch
  // or a poll from tearing the terminal down. Restored from localStorage on
  // load (plan 68 Idea 2) so a refresh re-attaches instead of dropping you on
  // the empty state.
   openSession: null,
  // Pane state of the open session (live / tuiAlive / cwd), see fetchSessionState.
  sessionState: null,
  // The session currently being auto-reopened (plan 68), keyed by id so only
  // the row col 3 is showing gets the transient "Reopening…" state. A bare
  // boolean would mark every row at once, the same mistake `startingKey` fixed.
  reopenFor: null,
  // Why an auto-reopen failed, shown in col 3 with the manual Reopen button as
  // the retry. Cleared when a later open or a successful restart moves past it.
  reopenError: '',
  starting: false,
  // WHICH action is opening, so only that one row shows "opening…". See
  // `startSession` — a bare `starting` boolean marked every row at once.
  startingKey: null,
  // Folder probe for the dialog: { agent, path, exists, isDir, entries, checking, error }
  folder: null,

  // Restoration is a READ, independent of the listing. Only an accepted fresh
  // row-click navigation may opt into recovery; POP/reload never does.
  restoreView: async ({ project = '', session = '', conversation = '', terminalProject = '', subfolders = false }, { autoReopen = false, fresh = false } = {}) => {
    ++startToken
    const changedScope = project !== get().selectedProjectId || subfolders !== get().includeSubfolders
    if (changedScope) {
      ++listToken
      ++historyToken
      set({ selectedProjectId: project, includeSubfolders: subfolders, sessions: [], history: null, loadedFor: '', allLoaded: false })
      get().refreshActive()
      if (project) get().fetchHistory(project, subfolders)
    }
    // Popup/list navigation for the same terminal must not reset its pane state.
    // This return sits ABOVE the view-generation bump on purpose: a navigation
    // that changes nothing about col 3 must not cancel the pane read already in
    // flight for it. `startSession` opens the session and then moves the URL,
    // which lands here; bumping first threw its pane read away and the new
    // session sat on "Checking session…" until the next poll.
    if (!fresh && session && get().openSession?.id === session && !get().viewError) return
    const token = ++viewToken
    set({ viewLoading: !!(session || conversation), viewError: '', viewUnavailable: false, historyView: null })
    if (!session && !conversation) {
      set({ openSession: null, sessionState: null, selectedConversationId: '', viewLoading: false })
      return
    }
    set({ openSession: null, sessionState: null, reopenFor: null, reopenError: '' })
    try {
      if (session) {
        const data = await api(`/api/mission/sessions/${encodeURIComponent(session)}`)
        const owner = data.project || (await api(`/api/mission/projects/${encodeURIComponent(data.session.project_id)}`)).project
        if (token !== viewToken) return
        const snapshot = snapshotOf({ ...data.session, project: owner }, get().projects)
        set({ openSession: { ...snapshot, runner: data.runner || null }, sessionState: data.state || null,
          selectedConversationId: snapshot.agentSessionId || session, viewLoading: false })
        get().fetchOpenRunnerQueue()
        if (autoReopen) get().fetchSessionState(session, { autoReopen: true })
      } else {
        if (!terminalProject) throw { status: 404, error: 'This history link has no owner project.' }
        const data = await api(`/api/mission/projects/${encodeURIComponent(terminalProject)}/conversations/${encodeURIComponent(conversation)}`)
        if (token !== viewToken) return
        set({ historyView: { conversation, project: data.project, metadata: data.conversation }, selectedConversationId: conversation, viewLoading: false })
      }
    } catch (e) {
      if (token !== viewToken) return
      const unavailable = [403, 404].includes(e?.status)
      set({ viewLoading: false, viewError: errText(e, 'Could not restore this view'), viewUnavailable: unavailable })
    }
  },

  fetchProjects: async () => {
    const token = ++projectToken
    try {
      const data = await api('/api/mission/projects')
      if (token !== projectToken) return
      const projects = data.projects || []
      const selectedBefore = get().selectedProjectId
      set((s) => {
        const patch = {
          projects,
          loading: false,
          error: '',
          // Keep the selection only if the project is still there. If it is
          // gone (deleted elsewhere), THAT becomes the no-selection / all view —
          // plan 68 did away with the "always one selected" fallback (Finding A),
          // and restoring it would be the same dead-end the finding named.
          // (This read `navigateView || some(...) ? sel : ''`, which parses as
          // `(navigateView || some(...)) ? …`; navigateView is always set on the
          // Mission page, so a vanished project was never deselected and its
          // 404 looped against this read for ever.)
          selectedProjectId: projects.some((p) => p.id === s.selectedProjectId) ? s.selectedProjectId : '',
        }
        // The open terminal is resolved by its OWN detail read. A listing is
        // not authority to clear another view's pinned snapshot.
        return patch
      })
      // No selection = the all view — and with it the column's entire read. A
      // selection change below never leaves the list pointing at the other
      // scope, so there is exactly one "re-read what the selection resolves to":
      // the aggregate when there is none, the project's own rows when there is.
      const sel = get().selectedProjectId
      // The URL owns the selection on the Mission page: when the selected
      // project is gone, take it out of the URL too, or the next navigation
      // event would put the dead id straight back.
      if (!sel && selectedBefore) get().navigateView?.({ project: '' }, { replace: true })
      if (!sel) {
        if (!get().allLoaded) get().fetchAll()
      } else if (get().loadedFor !== sel) {
        get().fetchSessions(sel)
        get().fetchHistory(sel, get().includeSubfolders)
      }
    } catch (e) {
      if (token !== projectToken) return
      set({ loading: false, error: errText(e, 'Could not load projects') })
    }
  },

  /** Selecting a project makes it the col 2 scope: its sessions AND its history
   *  load, and the empty col-2 state becomes "this project". Clicking the SAME
   *  project again DESELECTS it back to the all view (plan 68 Idea 1) — the
   *  no-selection state is real, and the lists are swapped for the aggregate.
   *  `scope` is gone; this one field IS the scope.
   *
   *  It deliberately does NOT close the open conversation. Col 3 belongs to the
   *  session you opened, not to the listing you are looking at, and a project
   *  click is not "close what I am working in". Col 3 keeps its terminal and
   *  names the open session's own project in its header, so col 1/col 2 and
   *  col 3 pointing at different projects is legible rather than confusing. */
  select: (projectId) => {
    if (get().navigateView) return get().navigateView({ project: get().selectedProjectId === projectId ? '' : projectId })
    if (get().selectedProjectId === projectId) {
      set({ selectedProjectId: '', selectedConversationId: '', sessions: [], history: null, loadedFor: '' })
      get().fetchAll()
      return
    }
    set({ selectedProjectId: projectId, selectedConversationId: '', sessions: [], history: null, loadedFor: '' })
    if (projectId) {
      get().fetchSessions(projectId)
      get().fetchHistory(projectId, get().includeSubfolders)
    }
  },

  /** The "N more in subfolders" expander. Read against the current view: no
   *  selection means EVERY project's aggregated history, a selection means that
   *  project's own — expanding must not quietly show one project's subfolders
   *  under a heading that claims to cover all of them. */
  setSubfolders: (on) => {
    if (get().navigateView) return get().navigateView({ subfolders: on })
    set({ includeSubfolders: on })
    if (!get().selectedProjectId) return get().fetchAll()
    return get().fetchHistory(get().selectedProjectId, on)
  },

  /** Re-read whatever the current selection resolves to. Every mutation (start,
   *  close, relaunch, restart, lock) and the 15s poll go through this instead of
   *  `fetchSessions`, which is hard-wired to the col-1 project — refreshing
   *  that while the user is looking at the aggregate list would leave the
   *  visible list stale after every action. */
  refreshActive: () => {
    // Runner metadata refreshes with the listing (plan 85 §Phase 2): the ∞
    // badges and queue states decorate the session rows, so a poll that
    // refreshes sessions must refresh them too. Unawaited on purpose — the
    // listing must not wait on it, and the token guard drops a stale answer.
    // It never touches `openSession`, so the terminal cannot move.
    // The queue follows col 3, so the open runner's queue refreshes with the
    // cadence too (plan 86 §Phase 2) — a Run/Pause that `refreshActive`s gets
    // the post-write queue as well. Unawaited like fetchRunners: the listing
    // must not wait on it, and the token guard drops a stale answer.
    get().fetchRunners()
    get().fetchOpenRunnerQueue()
    if (!get().selectedProjectId) return get().fetchAll()
    return get().fetchSessions()
  },

  /** The "All projects" read: both halves in one go, so the column's two groups
   *  come from the same moment. A failed half still shows the other one — the
   *  sessions list and the history list are not the same data, and a dead PAD
   *  for one project must not blank the other. */
  fetchAll: async () => {
    const token = ++listToken
    const ht = ++historyToken
    const sub = get().includeSubfolders
    // A per-project cap, not one global cap: "the latest 50" across every
    // project would let one chatty project hide every other project entirely.
    const perProject = sub ? 100 : 50
    set({ allLoading: true, allError: '' })
    const [sessionsRes, historyRes] = await Promise.allSettled([
      api('/api/mission/sessions'),
      api(`/api/mission/history?limit=${perProject}${sub ? '&subfolders=1' : ''}`),
    ])
    if (token !== listToken || ht !== historyToken || get().selectedProjectId) return

    if (sessionsRes.status === 'fulfilled') {
      const sessions = sessionsRes.value.sessions || []
      set((s) => ({
        sessions,
        sessionsLoading: false,
        allLoaded: true,
        // The fetch PRESERVES the user's highlight and never picks a row: this
        // IS the no-selection view, and inventing a highlight here is exactly
        // plan 73's phantom `msn-row-selected`. The helper cannot move the col-1
        // selection either, because a row's project must not turn the aggregate
        // view into a one-project view (plan 68 Idea 1).
        ...followSessionPatch(sessions, s.selectedConversationId),
      }))
    } else {
      set({
        allLoading: false,
        allError: errText(sessionsRes.reason, 'Could not load sessions'),
      })
    }

    if (historyRes.status === 'fulfilled') {
      const h = historyRes.value
      set({
        // Reshaped into the SAME shape the project scope returns, so the column
        // has one render path: the aggregated conversations are just the union
        // of the two groups, still sorted newest-first by the backend.
        history: {
          available: h.available,
          exactCount: h.exactCount,
          exact: (h.conversations || []).filter((c) => !c.subfolder),
          subfolders: (h.conversations || []).filter((c) => c.subfolder),
          subfolderCount: h.subfolderCount,
          projectCount: h.projectCount,
          total: h.total,
        },
        historyLoading: false,
        historyErrors: h.errors || [],
        includeSubfolders: sub,
      })
    } else {
      set({ historyLoading: false, historyError: errText(historyRes.reason, 'Could not load the agent history') })
    }

    const open = get().openSession?.id
    if (open) get().fetchSessionState(open)
  },

  fetchSessions: async (projectId) => {
    const id = projectId || get().selectedProjectId
    if (!id) return
    const token = ++listToken
    set({ sessionsLoading: true, sessionsError: '' })
    try {
      const data = await api(`/api/mission/projects/${id}/sessions`)
      if (token !== listToken || get().selectedProjectId !== id) return
      const sessions = data.sessions || []
      set((s) => ({
        sessions,
        sessionsLoading: false,
        // Only once the data is actually here: `loadedFor` is what the UI reads
        // to tell a first load ("nothing yet, show Loading…") from a refresh
        // ("keep showing what we have"). Marking it up front would make the
        // placeholder impossible to ever show.
        loadedFor: id,
        // Preserve the user's highlight; a refetch is a READ and must never
        // adopt a row on its own (plan 73). The old "else follow the first live
        // one" fallback only made sense while col 3 derived from this list; the
        // `openSession` snapshot is why a dead pane no longer needs chasing.
        ...followSessionPatch(sessions, s.selectedConversationId),
      }))
    } catch (e) {
      if (token !== listToken || get().selectedProjectId !== id) return
      // The project can be deleted from under an open page (another tab, the
      // agent, a test run). Parking the error would leave col 2 permanently
      // broken with nothing to click — re-read the list instead, which reselects
      // whatever exists now.
      if (e?.status === 404) {
        // Drop the selection FIRST: re-reading the projects while still
        // pointing at the dead id is what made this branch call itself.
        set({ sessions: [], history: null, loadedFor: '', sessionsError: '', sessionsLoading: false, selectedProjectId: get().selectedProjectId === id ? '' : get().selectedProjectId })
        get().navigateView?.({ project: '' }, { replace: true })
        await get().fetchProjects()
        return
      }
      set({ sessionsLoading: false, sessionsError: errText(e, 'Could not load sessions') })
    }
    // Whichever session ends up OPEN gets its pane state re-read: start, close,
    // relaunch and unlock all land here, and a row that just opened is exactly
    // when the page needs to know whether a TUI is running in it. Keyed to
    // `openSession`, not to the highlight: a refresh must not spend this call on
    // a row nobody is looking at, and must not re-read for a session col 3 is
    // not showing.
    const open = get().openSession?.id
    if (open) get().fetchSessionState(open)
  },

  fetchHistory: async (projectId, includeSubfolders) => {
    const id = projectId || get().selectedProjectId
    if (!id) return
    const token = ++historyToken
    const sub = includeSubfolders === undefined ? get().includeSubfolders : includeSubfolders
    set({ historyLoading: true, historyError: '' })
    try {
      // Expanding asks for the service's maximum: a project on a parent folder
      // can have hundreds of conversations under it, and a list that quietly
      // stops at 100 with the label still saying "693" reads as a bug (and
      // hides the ones you wanted).
      const limit = sub ? 200 : 100
      const data = await api(
        `/api/mission/projects/${id}/history?limit=${limit}${sub ? '&subfolders=1' : ''}`
      )
      if (token !== historyToken || get().selectedProjectId !== id) return
      set({ history: data, historyLoading: false, includeSubfolders: sub, historyErrors: [] })
    } catch (e) {
      if (token !== historyToken || get().selectedProjectId !== id) return
      set({ historyLoading: false, historyError: errText(e, 'Could not load the agent history') })
    }
  },

  /** Open a fresh session, or resume one of the agent's past conversations.
   *  Both land in the same place: a live tmux session in the project folder. */
  startSession: async (projectId, { label = '', agentSessionId = '', sourceKey = '' } = {}) => {
    const id = projectId || get().selectedProjectId
    if (!id) return null
    // WHICH action is in flight, not just that one is. `startingKey` is what the
    // column keys its busy state off: driving it from a bare boolean made a
    // single click on one conversation mark all ~100 rows "opening…", because
    // every row received the same global flag. One click, one row.
    const key = sourceKey || `new:${id}`
    // Same-action re-entrancy guard, and it has to live HERE rather than in the
    // row's `busy` prop: `startingKey` is React state, so two activations in the
    // same tick (a double-click, or a click plus an Enter key) both read it as
    // unset and each start its own tmux session + TUI. A double-click is not a
    // rare thing to do, and two panes on one conversation is worse than a click
    // that did nothing. A DIFFERENT row is not blocked — it gets its own key.
    if (get().startingKey === key) return null
    // A second click on another row while one is still opening is allowed, so the
    // older request can finish AFTER the newer one. Without this token it would
    // then set the selection back to the session the user passed on, and clear
    // the busy state off the row they are actually waiting for.
    const token = ++startToken
    set({ starting: true, startingKey: key, sessionsError: '' })
    try {
      const data = await api(`/api/mission/projects/${id}/sessions`, {
        method: 'POST',
        body: { label, agentSessionId },
      })
      await get().refreshActive()
      // The re-read above puts the new row in `sessions` with its `live` flag
      // and (in the all view) its project, so the snapshot is built from
      // that row rather than from the POST response, which carries none of it.
      // Falls back to the response when the list has not caught up yet.
      if (data?.session?.id && token === startToken) {
        const row = get().sessions.find((s) => s.id === data.session.id)
        set({
          // The highlight is a CONVERSATION (plan 80): prefer the id the agent
          // minted for it, so a start and a later history row for the same chat
          // share one identity. A legacy row with no conversation falls back to
          // its mission id.
          selectedConversationId: data.session.agent_session_id || data.session.id,
          openSession: snapshotOf(row || { ...data.session, project_id: id }, get().projects),
        })
        // `refreshActive()` above spent its pane-state call on whatever was open
        // BEFORE this start, so its result is stamped against the new session and
        // col 3 would open on a stale "closed" verdict until the next poll. Re-read
        // for the session that is now open — it is the one on screen.
        // A start whose pane somehow did not come up reopens rather than showing
        // the closed notice, for the same reason a row click does.
        get().navigateView?.({ session: data.session.id })
        get().fetchSessionState(data.session.id, { autoReopen: true })
      }
      return data.session
    } catch (e) {
      throw e
    } finally {
      if (get().startingKey === key) set({ starting: false, startingKey: null })
    }
  },

  /** Open a row. The row carries its project (aggregate view) or the selection
   *  says which project it belongs to (project view) — either way the snapshot
   *  below captures the agent and folder the session runs against, so col 3
   *  renders the terminal for that project. It deliberately does NOT move col
   *  1's selection (`selectedProjectId`): the selection is the scope now, and
   *  opening a row in the all view must not yank the list off it (plan 68).
   *  The snapshot is what col 3 renders from, which covers the need the old
   *  move served — the right container for the session's own project.
   *
   *  This is one of the two things that write `openSession` (the other is
   *  `startSession`). Nothing else does, which is what makes col 3 immune to
   *  every refresh path. */
  selectSession: (sessionId) => {
    if (get().navigateView) return get().navigateView({ session: sessionId }, { explicitOpen: true })
    const row = get().sessions.find((s) => s.id === sessionId)
    set({
      // Highlight the CONVERSATION (plan 80), not the mission row: when the pane
      // closes, the row switches to its history twin keyed by the same
      // conversation id, and the highlight must follow it rather than vanish.
      // Closes deliberately do NOT clear this (see `closeSession`).
      selectedConversationId: row?.agent_session_id || sessionId || '',
      openSession: snapshotOf(row, get().projects),
      sessionState: null,
      reopenError: '',
    })
    // `autoReopen` — the user opened THIS row, so a dead pane means "reopen this
    // conversation", not "show the closed notice" (plan 68).
    if (sessionId) get().fetchSessionState(sessionId, { autoReopen: true })
  },

  /** Pane state for the OPEN session only. The list stays at one tmux call
   *  (`list-sessions`, which is all it needs for the liveness dot); whether a
   *  TUI is actually running, and in which directory, is one `paneState` call
   *  per session — so it is spent on the one session that is on screen. This is
   *  what tells the page Relaunch TUI (pane alive, shell running) apart from
   *  Reopen (nothing running at all).
   *
   *  `autoReopen` is the plan 68 opt-in: the user just OPENED a session (row
   *  click or a fresh start) and it has no pane, so restart it once, same
   *  conversation, same tmux id. It is deliberately NOT on the refresh/poll
   *  path — a pane that dies while you are watching it is a "the container died
   *  under me" moment, and silently launching an agent process for it is not
   *  something to do without being asked. Keeping the flag at the call site is
   *  what makes that distinction visible instead of implicit. */
  fetchSessionState: async (sessionId, { autoReopen = false } = {}) => {
    const id = sessionId || get().openSession?.id
    if (!id) return null
    // A later plain read (a poll, a refresh after a mutation) supersedes this
    // one. The user's opt-in to reopen must not be lost with it, so it is
    // remembered for the session and honoured by whichever read lands.
    if (autoReopen) pendingAutoReopen.set(id, Date.now())
    else if (Date.now() - (pendingAutoReopen.get(id) || 0) < AUTO_REOPEN_WINDOW_MS) autoReopen = true
    const token = ++paneToken
    const generation = viewToken
    let state = null
    try {
      const data = await api(`/api/mission/sessions/${id}`)
      if (token !== paneToken || generation !== viewToken) return null
      state = data.state || null
      // The user may have clicked another row while this was in flight.
      // Alongside the pane state, refresh the snapshot's DISPLAY title from the
      // detail read (plan 80) — the agent renames a conversation after it starts,
      // and col 3's header must follow it. This updates a display field only:
      // which session is OPEN is untouched, exactly the plan 58 contract.
      set((s) => (s.openSession?.id === id
        ? {
          sessionState: state,
          openSession: {
            ...s.openSession,
            title: data.session?.title || s.openSession.title,
            // Plan 85 §Phase 3: the open session's OWN runner binding, read
            // from the detail response — this is what the terminal header's
            // Run/Pause + queue state render from, so they follow the session
            // col 3 is showing and never the project col 1 has selected.
            runner: data.runner || null,
          },
        }
        : s))
    } catch (e) {
      if (token !== paneToken || generation !== viewToken) return null
      set((s) => (s.openSession?.id === id ? {
        viewError: errText(e, 'Could not read session state'),
        viewUnavailable: [403, 404].includes(e?.status),
        ...([403, 404].includes(e?.status) ? { openSession: null, sessionState: null } : {}),
      } : s))
      return null
    }
    pendingAutoReopen.delete(id) // a read landed: the opt-in is spent either way
    if (!autoReopen || !state || state.live !== false) return state
    // They left on a different row while the read was in flight — restarting now
    // would relaunch a conversation nobody is looking at.
    if (get().openSession?.id !== id) return state
    // One auto-reopen per open. `reopenFor` is only cleared when this settles, so
    // a second read of the same dead row while the restart is still in flight
    // does not fire a second `restart` (two live panes on one conversation).
    if (get().reopenFor === id) return state
    set({ reopenFor: id, reopenError: '' })
    try {
      await api(`/api/mission/sessions/${id}/restart`, { method: 'POST' })
      await get().refreshActive()
    } catch (e) {
      if (get().openSession?.id === id) set({ reopenError: errText(e, 'Could not reopen this conversation') })
    }
    // Read the pane again BEFORE dropping `reopenFor`, and await it. Order is the
    // whole point: `sessionState` still holds the pre-restart `{ live: false }`
    // read from above, so clearing `reopenFor` first makes col 3 fall through to
    // the dead-end branch and flash "This session is closed" — with the Reopen
    // button — for the length of this read, on the one path that is *succeeding*.
    // Measured in the browser: Reopening… → "This session is closed" (376ms) →
    // terminal, i.e. a successful reopen briefly offers a pointless retry.
    //
    // `refreshActive` above may have re-stamped a DIFFERENT session, so this keys
    // off `openSession` rather than the id we were asked about, and it carries no
    // `autoReopen` — this read reports the outcome, it never triggers a second
    // restart.
    const open = get().openSession?.id
    if (open) await get().fetchSessionState(open)
    if (get().reopenFor === id) set({ reopenFor: null })
    return state
  },

  relaunch: async (sessionId) => {
    await api(`/api/mission/sessions/${sessionId}/relaunch`, { method: 'POST' })
    await get().refreshActive()
  },

  /** The pane is gone (PAD restarted, something killed it). Restart re-creates
   *  the same tmux session rooted at the project folder and reopens the same
   *  agent conversation — distinct from relaunch, which only re-runs the TUI
   *  inside a session that is still there. */
  restart: async (sessionId) => {
    await api(`/api/mission/sessions/${sessionId}/restart`, { method: 'POST' })
    await get().refreshActive()
  },

  /** Close a session. This is the ONE thing that clears `openSession` (when it
   *  is the session being closed): col 3 shows that conversation, so closing it
   *  is the only user action that legitimately empties the column.
   *
   *  It deliberately does NOT clear the HIGHLIGHT (plan 80). Closing the pane
   *  removes the pane, not the conversation: the row comes straight back as its
   *  history twin keyed by the same conversation id, and the user asked for it
   *  to stay selected. Clearing here is what made a closed session look like a
   *  different, unselected item. */
  closeSession: async (sessionId) => {
    const before = get().openSession
    await api(`/api/mission/sessions/${sessionId}`, { method: 'DELETE' })
    set((s) => (s.openSession?.id === sessionId ? { openSession: null, sessionState: null } : {}))
    get().navigateView?.({ closedSession: sessionId, conversation: before?.agentSessionId || '', terminalProject: before?.projectId || '' }, { replace: true })
    await get().refreshActive()
  },

  // A popout hands the VIEW to another window. It must not affect the pane,
  // runner or conversation; only clear the embedded snapshot when it matches.
  detachSession: (sessionId) => {
    if (get().openSession?.id !== sessionId) return false
    set({ openSession: null, sessionState: null, reopenFor: null, reopenError: '' })
    get().navigateView?.({ session: null }, { replace: true })
    return true
  },

  toggleSessionLock: async (sessionId, locked) => {
    await api(`/api/mission/sessions/${sessionId}`, { method: 'PATCH', body: { locked } })
    await get().refreshActive()
  },

  createProject: async (payload) => {
    const data = await api('/api/mission/projects', { method: 'POST', body: payload })
    await get().fetchProjects()
    if (data?.project?.id) {
      // Selecting the new project makes it the col-1 selection — and since the
      // selection IS the scope (plan 68), that also makes col 2 show it and
      // gives `+ New session` a target. A new project is immediately usable
      // without re-navigating.
      set({ selectedProjectId: data.project.id, selectedConversationId: '', sessions: [], history: null, loadedFor: '' })
      get().fetchSessions(data.project.id)
      get().fetchHistory(data.project.id, get().includeSubfolders)
      get().navigateView?.({ project: data.project.id }, { replace: true })
    }
    return data.project
  },

  updateProject: async (id, payload) => {
    const before = get().projects.find((p) => p.id === id)
    const data = await api(`/api/mission/projects/${id}`, { method: 'PATCH', body: payload })
    // A new folder is a new scope: the history we loaded belongs to the old
    // one, so drop the cache key and re-read instead of leaving stale rows up.
    const folderChanged = before && data?.project && before.folder !== data.project.folder
    await get().fetchProjects()
    if (folderChanged) {
      set({ history: null, loadedFor: '' })
      if (!get().selectedProjectId) get().fetchAll()
      else if (get().selectedProjectId === id) {
        get().fetchSessions(id)
        get().fetchHistory(id, get().includeSubfolders)
      }
    }
    return data.project
  },

  deleteProject: async (id) => {
    await api(`/api/mission/projects/${id}`, { method: 'DELETE' })
    // The highlight clears, and with it the row — but `openSession` does NOT.
    // Deleting a project kills the sessions running on it, so col 3 is about to
    // find out from its own pane poll that nothing is running there and say so
    // in its own words, with a Reopen button. Snapping the terminal to a
    // neighbour instead would throw away the conversation the user was looking
    // at, at the exact moment they are told it is gone.
    set({ selectedConversationId: '', sessions: [], history: null, loadedFor: '' })
    await get().fetchProjects()
    // The aggregate list held rows from the project that is now gone; the
    // project list re-read above already reset the selection to whatever
    // exists (possibly `''`), so re-read the visible list too or col 2 would
    // keep showing a project that is not there.
    if (!get().selectedProjectId) get().fetchAll()
  },

  /** Probe a container folder inside the PAD. Never throws: a missing folder is
   *  a normal state while typing, and the sibling entries are the useful part. */
  probeFolder: async (agent, path) => {
    if (!agent || !path) {
      set({ folder: null })
      return null
    }
    // `req` is the raw input and is what the guard compares — the backend
    // normalizes (a trailing slash goes away), so comparing the response's
    // normalized path against a raw request would drop valid answers. The agent
    // is part of the key: the same path probed for a different PAD is a
    // different question, and the late answer must not overwrite the new one.
    set({ folder: { agent, req: path, path, checking: true, exists: false, isDir: false, entries: [], error: '' } })
    try {
      const data = await api(`/api/agents/${agent}/mission-folders?path=${encodeURIComponent(path)}`)
      set((s) => (s.folder?.agent === agent && s.folder?.req === path
        ? { folder: { ...s.folder, ...data, path: data.path || path, checking: false, error: '' } }
        : s))
      return data
    } catch (e) {
      set((s) => (s.folder?.agent === agent && s.folder?.req === path
        ? { folder: { ...s.folder, checking: false, exists: false, isDir: false, entries: [], error: errText(e) } }
        : s))
      return null
    }
  },

  clearFolder: () => set({ folder: null }),

  // Runners (plan 83, merged listing plan 85). One array for the visible
  // scope: the selected project's runners, or EVERY accessible project's in
  // the all view. `runnersFor` is the scope the response belongs to — a slow
  // project response that lands after a scope switch must not relabel another
  // scope's rows (plan 85 §Phase 2).
  fetchRunners: async (projectId) => {
    const id = projectId || get().selectedProjectId || ''
    const token = ++runnerToken
    set({ runnersLoading: true, runnersError: '' })
    try {
      const data = await api(id ? `/api/mission/projects/${id}/runners` : '/api/mission/runners')
      if (token !== runnerToken) return
      // Tag each row with the scope it was read for. The project route returns
      // bare rows; the all route already tags them.
      const runners = (data.runners || []).map((r) => (r.project ? r : { ...r, scopeProjectId: id }))
      set({ runners, runnersFor: id, runnersLoading: false, runnersError: '' })
    } catch (e) {
      if (token !== runnerToken) return
      set({ runnersLoading: false, runnersError: errText(e, 'Could not load runners') })
    }
  },

  // The runner col 3 is showing. Col 3 belongs to the OPEN session, never to
  // col 1's selection (plan 85), so this resolves from the open snapshot:
  // prefer the runners row bound to the open session (fresh state on every
  // poll), fall back to the runner embedded in the snapshot itself (usable the
  // instant a restored session opens, before the runners list has landed).
  openRunner: () => {
    const open = get().openSession
    if (!open) return null
    const bound = get().runners.find((r) => r.session_id === open.id || r.session_id === open.session_id)
    return bound || open.runner || null
  },

  // Plan 86 §Phase 2: the queue of the open runner, fetched independently of
  // the column-1 selection and folded into the existing refresh cadence (no
  // timer per row, no fleet scan). Two guards keep it honest:
  //  - `queueToken`: an answer that lands after the open session changed is
  //    dropped WITHOUT touching the new conversation's snapshot.
  //  - a FAILED refresh keeps the last snapshot but marks it `queueStale` — a
  //    failed read is never presented as a fresh current/next claim.
  fetchOpenRunnerQueue: async () => {
    const runner = get().openRunner()
    const id = runner?.id || ''
    if (!id) {
      set({ queue: null, queueForRunner: '', queueLoading: false, queueError: '', queueStale: false })
      return
    }
    const token = ++queueToken
    // Background refreshes of the SAME runner keep the current snapshot on
    // screen (no loading flicker per poll); only a conversation switch
    // shows loading.
    if (get().queueForRunner !== id) set({ queueLoading: true, queueError: '' })
    try {
      const data = await api(`/api/mission/runners/${id}/queue`)
      if (token !== queueToken) return
      if ((get().openRunner()?.id || '') !== id) return
      set({ queue: queueOf(data), queueForRunner: id, queueLoading: false, queueError: '', queueStale: false })
    } catch (e) {
      if (token !== queueToken) return
      const retained = get().queueForRunner === id
      set({ queueLoading: false, queueError: errText(e, 'Could not read the queue'), queueStale: retained })
    }
  },

  // Setup creates only the ABSENT file with instructions (plan 86 §1/2) — it
  // never starts execution and never overwrites an existing queue.
  setupRunnerQueue: async (runnerId, { confirmProjectionReset = false } = {}) => {
    if (get().queueAction) return
    set({ queueAction: 'setup', queueError: '' })
    get().clearOperationFeedback(runnerId)
    try {
      const data = await api(`/api/mission/runners/${runnerId}/queue`, { method: 'POST', body: { confirmProjectionReset } })
      set({ queue: queueOf(data), queueForRunner: runnerId, queueLoading: false, queueError: '', queueStale: false })
      get().refreshActive()
      get().setOperationFeedback(runnerId, { severity: 'success', message: 'Queue set up successfully' })
      return data
    } catch (e) {
      set({ queueAction: '', queueError: errText(e, 'Could not set up the queue') })
      get().setOperationFeedback(runnerId, { severity: 'error', message: errText(e, 'Could not set up the queue') })
      throw e
    } finally {
      set({ queueAction: '' })
    }
  },

  // CAS write (plan 86 §Phase 1): the server refuses a stale revision, so the
  // caller here surfaces the conflict as Reload queue — never an automatic
  // overwrite or retry of an edit that raced the worker.
  updateRunnerQueue: async (runnerId, items, revision) => {
    if (get().queueAction) return
    set({ queueAction: 'update', queueError: '' })
    get().clearOperationFeedback(runnerId)
    try {
      const data = await api(`/api/mission/runners/${runnerId}/queue`, {
        method: 'PUT',
        body: { items, revision },
      })
      set({ queue: queueOf(data), queueForRunner: runnerId, queueLoading: false, queueError: '', queueStale: false })
      get().refreshActive()
      get().setOperationFeedback(runnerId, { severity: 'success', message: 'Queue updated' })
      return data
    } catch (e) {
      // Both = the server refused the write because our revision no longer
      // matches (or we could not supply one at all) — show Reload queue.
      if (e?.code === 'queue_revision_conflict' || e?.code === 'queue_revision_required') {
        set({ queueError: errText(e, 'The queue changed elsewhere'), queueStale: true })
        get().setOperationFeedback(runnerId, { severity: 'warning', message: 'The queue changed elsewhere — reload and retry' })
      } else {
        set({ queueError: errText(e, 'Could not update the queue') })
        get().setOperationFeedback(runnerId, { severity: 'error', message: errText(e, 'Could not update the queue') })
      }
      throw e
    } finally {
      set({ queueAction: '' })
    }
  },

  addRunnerQueueItems: async (runnerId, plans, revision) => {
    if (get().queueAction) return
    set({ queueAction: 'add', queueError: '' })
    try {
      // Appending commutes with whatever else changed the queue, and a running
      // worker bumps the revision every time it updates an item — so a stale
      // revision here is routine, not a conflict the user should resolve by
      // hand. Re-read once and retry against the fresh revision.
      const post = (rev) => api(`/api/mission/runners/${runnerId}/queue/items`, { method: 'POST', body: { plans, revision: rev } })
      let data
      try {
        data = await post(revision)
      } catch (e) {
        if (e?.code !== 'queue_revision_conflict') throw e
        const fresh = queueOf(await api(`/api/mission/runners/${runnerId}/queue`))
        data = await post(fresh.revision)
      }
      set({ queue: queueOf(data), queueForRunner: runnerId, queueLoading: false, queueError: '', queueStale: false })
      return data
    } catch (e) {
      get().queueMutationFailed(runnerId, e)
      throw e
    } finally {
      set({ queueAction: '' })
    }
  },

  reorderRunnerQueue: async (runnerId, itemIds, revision) => {
    if (get().queueAction) return
    set({ queueAction: 'reorder', queueError: '' })
    try {
      const data = await api(`/api/mission/runners/${runnerId}/queue/order`, { method: 'PUT', body: { itemIds, revision } })
      set({ queue: queueOf(data), queueForRunner: runnerId, queueLoading: false, queueError: '', queueStale: false })
      return data
    } catch (e) {
      get().queueMutationFailed(runnerId, e)
      throw e
    } finally {
      set({ queueAction: '' })
    }
  },

  removeRunnerQueueItem: async (runnerId, itemId, revision) => {
    if (get().queueAction) return
    set({ queueAction: 'remove', queueError: '' })
    try {
      const data = await api(`/api/mission/runners/${runnerId}/queue/items/${encodeURIComponent(itemId)}`, { method: 'DELETE', body: { revision } })
      set({ queue: queueOf(data), queueForRunner: runnerId, queueLoading: false, queueError: '', queueStale: false })
      return data
    } catch (e) {
      get().queueMutationFailed(runnerId, e)
      throw e
    } finally {
      set({ queueAction: '' })
    }
  },

  updateRunnerQueueItem: async (runnerId, itemId, { status, reason = '' }, revision) => {
    if (get().queueAction) return
    set({ queueAction: 'status', queueError: '' })
    try {
      const data = await api(`/api/mission/runners/${runnerId}/queue/items/${encodeURIComponent(itemId)}`, {
        method: 'PATCH', body: { status, reason, revision },
      })
      set({ queue: queueOf(data), queueForRunner: runnerId, queueLoading: false, queueError: '', queueStale: false })
      get().setOperationFeedback(runnerId, { severity: 'success', message: 'Queue item status reviewed and saved' })
      return data
    } catch (e) {
      get().queueMutationFailed(runnerId, e)
      throw e
    } finally {
      set({ queueAction: '' })
    }
  },

  queueMutationFailed: (runnerId, e) => {
    const stale = ['queue_revision_conflict', 'queue_revision_required'].includes(e?.code)
    const message = errText(e, 'Could not update the queue')
    if (get().queueForRunner === runnerId) set({ queueError: message, queueStale: stale })
    get().setOperationFeedback(runnerId, { severity: stale ? 'warning' : 'error', message })
  },

  getRunnerQueue: async (runnerId) => api(`/api/mission/runners/${runnerId}/queue`),

  updateRunnerQueueCustomInstructions: async (runnerId, customInstructions, revision) => {
    return api(`/api/mission/runners/${runnerId}/queue/custom-instructions`, {
      method: 'PUT',
      body: { customInstructions, revision },
    })
  },

  // Resolve a blocked queue item: POST to /resolve, then reload queue.
  // Uses operationFeedback (not queueError) so the panel banner reports success/failure.
  resolveRunnerQueue: async (runnerId, { itemId, answer, revision }) => {
    if (get().queueAction) return
    set({ queueAction: 'resolve', queueError: '' })
    get().clearOperationFeedback(runnerId)
    try {
      const result = await api(`/api/mission/runners/${runnerId}/resolve`, {
        method: 'POST',
        body: { itemId, answer, revision },
      })
      get().setOperationFeedback(runnerId, result?.awaitingReceipt
        ? { severity: 'warning', message: 'Answer delivery is unconfirmed — no resend made. Reconcile the exact receipt before continuing.' }
        : { severity: 'success', message: 'Answer accepted — queue resumed' })
      await get().reloadRunnerQueue()
      return result
    } catch (e) {
      get().setOperationFeedback(runnerId, {
        severity: e?.code === 'queue_revision_conflict' ? 'warning' : 'error',
        message: errText(e, 'Could not send the answer'),
      })
      throw e
    } finally {
      set({ queueAction: '' })
    }
  },

  // Reconcile an unconfirmed runner operation: check the agent's store for
  // the exact receipt and transition the operation state accordingly.
  reconcileRunnerOperation: async (runnerId) => {
    if (get().queueAction) return
    set({ queueAction: 'reconcile', queueError: '' })
    get().clearOperationFeedback(runnerId)
    try {
      const result = await api(`/api/mission/runners/${runnerId}/reconcile`, {
        method: 'POST',
      })
      // Reload queue and runner to reflect the new state
      await get().reloadRunnerQueue()
      await get().fetchRunners()
      if (result.confirmed) {
        get().setOperationFeedback(runnerId, { severity: 'success', message: 'Instruction confirmed — queue resumed' })
      } else if (result.held) {
        get().setOperationFeedback(runnerId, { severity: 'warning', message: result.reason || 'No response received — operation held' })
      } else if (result.awaiting) {
        get().setOperationFeedback(runnerId, { severity: 'info', message: 'Instruction still unconfirmed — worker may be processing' })
      }
      return result
    } catch (e) {
      get().setOperationFeedback(runnerId, {
        severity: 'error',
        message: errText(e, 'Could not reconcile the operation'),
      })
      throw e
    } finally {
      set({ queueAction: '' })
    }
  },

  reloadRunnerQueue: () => get().fetchOpenRunnerQueue(),

  // Centralized feedback for queue operations (plan 98 §Phase 1).
  setOperationFeedback: (runnerId, feedback) => {
    // Server refusals end with a locator for MCP callers
    // (` [project:… session:…]`). It is noise to a person looking at the very
    // session it names, so the panel's line drops it.
    if (feedback && typeof feedback.message === 'string') {
      feedback = { ...feedback, message: feedback.message.replace(/\s*\[project:[^\]]*\]\s*$/, '') }
    }
    set((s) => ({
      operationFeedback: { ...s.operationFeedback, [runnerId]: feedback }
    }))
  },

  clearOperationFeedback: (runnerId) => {
    set((s) => {
      const next = { ...s.operationFeedback }
      delete next[runnerId]
      return { operationFeedback: next }
    })
  },

  // After every runner mutation the ACTIVE listing is re-read (plan 85
  // §Phase 2/3): the ∞ badges decorate the session rows, and a Run may have
  // created/recovered the bound session — refreshing only the runner array
  // would leave the worker row stale until the next poll. `refreshActive`
  // never moves `openSession`, so the terminal keeps its identity.
  createRunner: async (payload) => {
    // Explicit project identity (plan 85 §Phase 3): the dialog submits the
    // project the runner belongs to — in the all view col 1 selects nothing,
    // and the old `selectedProjectId` read silently created nowhere.
    const id = payload?.projectId || get().selectedProjectId
    if (!id) return null
    set({ runnersLoading: true, runnersError: '' })
    try {
      const data = await api(`/api/mission/projects/${id}/runners`, {
        method: 'POST',
        body: payload,
      })
      await get().refreshActive()
      return data.runner
    } catch (e) {
      set({ runnersLoading: false, runnersError: errText(e, 'Could not create runner') })
      throw e
    }
  },

  updateRunner: async (runnerId, payload) => {
    set({ runnersLoading: true, runnersError: '' })
    try {
      const data = await api(`/api/mission/runners/${runnerId}`, {
        method: 'PATCH',
        body: payload,
      })
      await get().refreshActive()
      return data.runner
    } catch (e) {
      set({ runnersLoading: false, runnersError: errText(e, 'Could not update runner') })
      throw e
    }
  },

  startRunner: async (runnerId) => {
    get().clearOperationFeedback(runnerId)
    set({ runnersLoading: true, runnersError: '' })
    try {
      const data = await api(`/api/mission/runners/${runnerId}/start`, {
        method: 'POST',
      })
      await get().refreshActive()
      get().setOperationFeedback(runnerId, { severity: 'success', message: data.recovering ? 'Quota recovery started — running your callback before restoring the session' : 'Queue started' })
      return data
    } catch (e) {
      set({ runnersLoading: false, runnersError: errText(e, 'Could not start runner') })
      get().setOperationFeedback(runnerId, { severity: 'error', message: errText(e, 'Could not start runner') })
      throw e
    }
  },

  pauseRunner: async (runnerId, mode) => {
    get().clearOperationFeedback(runnerId)
    set({ runnersLoading: true, runnersError: '' })
    try {
      const data = await api(`/api/mission/runners/${runnerId}/pause`, {
        method: 'POST',
        body: mode ? { mode } : undefined,
      })
      await get().refreshActive()
      get().setOperationFeedback(runnerId, { severity: 'warning', message: mode === 'current_task' ? 'Asked the worker to stop the current plan' : 'Queue paused — the plan in progress will finish, no new plan will start' })
      return data
    } catch (e) {
      set({ runnersLoading: false, runnersError: errText(e, 'Could not pause runner') })
      get().setOperationFeedback(runnerId, { severity: 'error', message: errText(e, 'Could not pause runner') })
      throw e
    }
  },

  resumeRunner: async (runnerId) => {
    get().clearOperationFeedback(runnerId)
    set({ runnersLoading: true, runnersError: '' })
    try {
      const data = await api(`/api/mission/runners/${runnerId}/resume`, {
        method: 'POST',
      })
      await get().refreshActive()
      get().setOperationFeedback(runnerId, { severity: 'success', message: 'Runner resumed' })
      return data
    } catch (e) {
      set({ runnersLoading: false, runnersError: errText(e, 'Could not resume runner') })
      get().setOperationFeedback(runnerId, { severity: 'error', message: errText(e, 'Could not resume runner') })
      throw e
    }
  },

  removeRunner: async (runnerId) => {
    get().clearOperationFeedback(runnerId)
    set({ runnersLoading: true, runnersError: '' })
    try {
      await api(`/api/mission/runners/${runnerId}`, { method: 'DELETE' })
      await get().refreshActive()
      get().setOperationFeedback(runnerId, { severity: 'success', message: 'Runner removed' })
    } catch (e) {
      set({ runnersLoading: false, runnersError: errText(e, 'Could not remove runner') })
      get().setOperationFeedback(runnerId, { severity: 'error', message: errText(e, 'Could not remove runner') })
      throw e
    }
  },

  getRunner: async (runnerId) => {
    set({ runnersLoading: true, runnersError: '' })
    try {
      const data = await api(`/api/mission/runners/${runnerId}`)
      return data.runner
    } catch (e) {
      set({ runnersLoading: false, runnersError: errText(e, 'Could not load runner') })
      throw e
    } finally {
      set({ runnersLoading: false })
    }
  },

  // Plan 91 §Phase 3: prompt-template configuration reads. One-shot fetches —
  // the dialog holds drafts locally, so nothing lands in store state. Preview
  // never sends, starts a session or changes queue state (server-enforced).
  getPromptConfig: async (runnerId) => {
    const data = await api(`/api/mission/runners/${runnerId}/prompts`)
    return data
  },

  previewRunnerPrompts: async (runnerId, drafts, overrides) => {
    const data = await api(`/api/mission/runners/${runnerId}/prompts/preview`, {
      method: 'POST',
      body: { drafts, overrides },
    })
    return data
  },

  previewProjectPrompts: async (projectId, drafts, overrides) => {
    const data = await api(`/api/mission/projects/${projectId}/prompts/preview`, {
      method: 'POST',
      body: { drafts, overrides },
    })
    return data
  },

  getProjectPromptCatalogue: async (projectId) => {
    const data = await api(`/api/mission/projects/${projectId}/prompts`)
    return data
  },

  // Plan 92 §Phase 4: lifecycle-callback settings reads/writes. One-shot
  // fetches — the dialog holds drafts locally. Saving never executes a
  // script (server-enforced; no executor exists yet).
  getRunnerCallbacks: async (runnerId) => {
    const data = await api(`/api/mission/runners/${runnerId}/callbacks`)
    return data
  },

  saveRunnerCallbacks: async (runnerId, callbacks) => {
    const data = await api(`/api/mission/runners/${runnerId}/callbacks`, {
      method: 'PUT',
      body: { callbacks },
    })
    return data
  },

  getRunnerCallbackHistory: async (runnerId) => {
    const data = await api(`/api/mission/runners/${runnerId}/callbacks/history`)
    return data
  },

  getProjectCallbackCatalogue: async (projectId) => {
    const data = await api(`/api/mission/projects/${projectId}/callbacks/catalogue`)
    return data
  },

  /** Open a runner's worker session (plan 85 §Phase 3): clicking an infinite
   *  row opens that session's normal terminal, whatever the queue is doing.
   *  For a BOUND session this is just `selectSession` — the same flow, the same
   *  recovery, and it never enables the queue. For a LEGACY UNBOUND runner
   *  there is no row to select, so the explicit open binds/creates the session
   *  first (the one place unbound records resolve, never list reads/polling),
   *  then selects it. Configuration never handles an open. */
  openRunnerSession: async (runner) => {
    if (!runner) return null
    if (runner.session_id) {
      get().selectSession(runner.session_id)
      return runner.session_id
    }
    set({ runnersLoading: true, runnersError: '' })
    try {
      const data = await api(`/api/mission/runners/${runner.id}/session`, { method: 'POST' })
      await get().refreshActive()
      if (data?.session?.id) get().selectSession(data.session.id)
      return data?.session?.id || null
    } catch (e) {
      set({ runnersLoading: false, runnersError: errText(e, 'Could not open the runner session') })
      throw e
    } finally {
      set({ runnersLoading: false })
    }
  },

  clearFolder: () => set({ folder: null }),
  }
})

// Idea 2 (plan 68): persist the three view fields on every change. `subscribe`
// fires when any state changes, so write the JSON blob always — cheap, and the
// hydrate side only reads back what it shaped. This is the ONLY touch point:
// `selectedProjectId` changes in dozens of places and none of them should have
// to remember to persist.
useMission.subscribe((s) => writePersistedView(s))
