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

/** "Which session is open" as ONE rule, used by every path that changes it —
 *  a click, a refresh that follows the first live row, the aggregate read.
 *
 *  A row in the 'all' scope also carries the project it belongs to, and col 1
 *  highlights that project. So following a row has to move both. Setting only
 *  `selectedSessionId` — which is what the project-scoped code did, correctly,
 *  because those rows have no project — makes col 1 highlight one project
 *  while the highlighted row is from another. In the project scope
 *  `next.project` is undefined, so this is the old behaviour unchanged.
 *
 *  This moves the HIGHLIGHT only. Which conversation col 3 shows is
 *  `openSession` (see `snapshotOf`), and a refresh must never touch it: the
 *  list is refetched, emptied and re-pointed for reasons that have nothing to
 *  do with the conversation the user is sitting in. */
function followSessionPatch(rows, currentId) {
  const pick = rows.find((s) => s.id === currentId) || rows.find((s) => s.live) || rows[0] || null
  const patch = { selectedSessionId: pick?.id || '' }
  if (pick?.project?.id) patch.selectedProjectId = pick.project.id
  return patch
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

export const useMission = create((set, get) => ({
  projects: [],
  loading: true,
  error: '',
  selectedProjectId: '',
  // Live tmux sessions of the selected project, and the agent's own history in
  // its folder.
  sessions: [],
  sessionsLoading: false,
  sessionsError: '',
  history: null,
  historyLoading: false,
  historyError: '',
  includeSubfolders: false,
  // Which list col 2 is showing (plan 53 Phase 6): 'project' = only the
  // selected project (the original behaviour), 'all' = every project at once.
  // ONE pair of arrays backs both scopes — `sessions` / `history` are whatever
  // the active scope resolved to — so the column has a single render path and
  // cannot show a stale list from the other scope.
  scope: 'project',
  allLoading: false,
  allError: '',
  // True once the aggregate read succeeded — the placeholder must not show on a
  // refresh, and must still show on a first load (same rule as `loadedFor`).
  allLoaded: false,
  // Which projects the aggregated history read failed for. Reported inline
  // instead of replacing the list: one stopped PAD must not hide the others.
  historyErrors: [],
  selectedSessionId: '',
  // The conversation col 3 is showing — a snapshot taken when it was opened, NOT
  // derived from `sessions`. See `snapshotOf`: this is what keeps a scope switch
  // or a poll from tearing the terminal down.
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

  fetchProjects: async () => {
    try {
      const data = await api('/api/mission/projects')
      const projects = data.projects || []
      set((s) => ({
        projects,
        loading: false,
        error: '',
        // Keep the selection if it survived the refresh, else fall back to the
        // first project — an empty col 2 is a dead end.
        selectedProjectId: projects.some((p) => p.id === s.selectedProjectId)
          ? s.selectedProjectId
          : projects[0]?.id || '',
      }))
      // A different project means the old sessions and history are wrong. In
      // 'all' scope the project list is still the trigger for re-reading, but
      // the list to re-read is the aggregate one.
      const sel = get().selectedProjectId
      if (get().scope === 'all') {
        if (!get().allLoaded) get().fetchAll()
      } else if (sel && get().loadedFor !== sel) {
        get().fetchSessions(sel)
        get().fetchHistory(sel, get().includeSubfolders)
      }
    } catch (e) {
      set({ loading: false, error: errText(e, 'Could not load projects') })
    }
  },

  /** Selecting a project loads its sessions AND its history — the history is
   *  what makes the column useful on arrival. In 'all' scope the aggregate list
   *  is already showing every project, so switching the col-1 selection only
   *  changes what a NEW session would belong to — re-reading the same rows
   *  would just cost a round trip.
   *
   *  It deliberately does NOT close the open conversation. It used to, and that
   *  was the same defect as the scope switch one level up: col 3 belongs to the
   *  session you opened, not to the listing you are looking at, and a project
   *  click is not "close what I am working in". Col 3 keeps its terminal and
   *  names the open session's own project in its header, so col 1/col 2 and
   *  col 3 pointing at different projects is legible rather than confusing. */
  select: (projectId) => {
    if (get().selectedProjectId === projectId) return
    set({ selectedProjectId: projectId, selectedSessionId: '' })
    if (get().scope === 'all') {
      if (!get().allLoaded) get().fetchAll()
      return
    }
    set({ sessions: [], history: null, loadedFor: '' })
    if (projectId) {
      get().fetchSessions(projectId)
      get().fetchHistory(projectId, get().includeSubfolders)
    }
  },

  /** Switch col 2 between "this project" and "all projects". The arrays are
   *  dropped first, deliberately: a list that keeps showing the other scope's
   *  rows for a moment reads as "the switch did nothing". The open conversation
   *  is not in those arrays and is not touched — only a click on a row changes
   *  what col 3 shows. */
  setScope: (scope) => {
    const next = scope === 'all' ? 'all' : 'project'
    if (get().scope === next) return
    set({ scope: next, sessions: [], history: null, loadedFor: '', allLoaded: false })
    if (next === 'all') return get().fetchAll()
    const sel = get().selectedProjectId
    if (sel) {
      get().fetchSessions(sel)
      get().fetchHistory(sel, get().includeSubfolders)
    }
  },

  /** The "N more in subfolders" expander. Scope-aware for the same reason the
   *  list itself is: in 'all' it re-reads EVERY project, not the one in col 1 —
   *  expanding must not quietly show one project's subfolders under a heading
   *  that claims to cover all of them. */
  setSubfolders: (on) => {
    set({ includeSubfolders: on })
    if (get().scope === 'all') return get().fetchAll()
    return get().fetchHistory(get().selectedProjectId, on)
  },

  /** Re-read whatever the active scope is showing. Every mutation (start, close,
   *  relaunch, restart, lock) and the 15s poll go through this instead of
   *  `fetchSessions`, which is hard-wired to the col-1 project — refreshing
   *  that while the user is looking at the aggregate list would leave the
   *  visible list stale after every action. */
  refreshActive: () => {
    if (get().scope === 'all') return get().fetchAll()
    return get().fetchSessions()
  },

  /** The "All projects" read: both halves in one go, so the column's two groups
   *  come from the same moment. A failed half still shows the other one — the
   *  sessions list and the history list are not the same data, and a dead PAD
   *  for one project must not blank the other. */
  fetchAll: async () => {
    const sub = get().includeSubfolders
    // A per-project cap, not one global cap: "the latest 50" across every
    // project would let one chatty project hide every other project entirely.
    const perProject = sub ? 100 : 50
    set({ allLoading: true, allError: '' })
    const [sessionsRes, historyRes] = await Promise.allSettled([
      api('/api/mission/sessions'),
      api(`/api/mission/history?limit=${perProject}${sub ? '&subfolders=1' : ''}`),
    ])

    if (sessionsRes.status === 'fulfilled') {
      const sessions = sessionsRes.value.sessions || []
      set((s) => ({
        sessions,
        sessionsLoading: false,
        allLoaded: true,
        // Same rule as the project scope: keep the open session, else follow a
        // live one. Going through the shared helper is what also moves col 1 to
        // that row's project — the aggregated list can hand us a session from a
        // project the user did not have selected.
        ...followSessionPatch(sessions, s.selectedSessionId),
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
    set({ sessionsLoading: true, sessionsError: '' })
    try {
      const data = await api(`/api/mission/projects/${id}/sessions`)
      const sessions = data.sessions || []
      set((s) => ({
        sessions,
        sessionsLoading: false,
        // Only once the data is actually here: `loadedFor` is what the UI reads
        // to tell a first load ("nothing yet, show Loading…") from a refresh
        // ("keep showing what we have"). Marking it up front would make the
        // placeholder impossible to ever show.
        loadedFor: id,
        // Keep the open session if it is still there, else follow the first
        // live one — landing on a dead pane with no way back is a dead end.
        ...followSessionPatch(sessions, s.selectedSessionId),
      }))
    } catch (e) {
      // The project can be deleted from under an open page (another tab, the
      // agent, a test run). Parking the error would leave col 2 permanently
      // broken with nothing to click — re-read the list instead, which reselects
      // whatever exists now.
      if (e?.status === 404) {
        set({ sessions: [], history: null, loadedFor: '', sessionsError: '' })
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
      set({ history: data, historyLoading: false, includeSubfolders: sub, historyErrors: [] })
    } catch (e) {
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
      // and (in the 'all' scope) its project, so the snapshot is built from
      // that row rather than from the POST response, which carries none of it.
      // Falls back to the response when the list has not caught up yet.
      if (data?.session?.id && token === startToken) {
        const row = get().sessions.find((s) => s.id === data.session.id)
        set({
          selectedSessionId: data.session.id,
          openSession: snapshotOf(row || { ...data.session, project_id: id }, get().projects),
        })
        // `refreshActive()` above spent its pane-state call on whatever was open
        // BEFORE this start, so its result is stamped against the new session and
        // col 3 would open on a stale "closed" verdict until the next poll. Re-read
        // for the session that is now open — it is the one on screen.
        // A start whose pane somehow did not come up reopens rather than showing
        // the closed notice, for the same reason a row click does.
        get().fetchSessionState(data.session.id, { autoReopen: true })
      }
      return data.session
    } catch (e) {
      if (token === startToken) set({ sessionsError: errText(e, 'Could not open the session') })
      throw e
    } finally {
      if (token === startToken) set({ starting: false, startingKey: null })
    }
  },

  /** Open a row. In the 'all' scope the row also carries the project it belongs
   *  to, and col 3 renders the terminal against that project — so a click has to
   *  move col 1 too, or opening a row from another project would show that
   *  session's pane in the wrong container. Project-scoped rows have no
   *  `.project`, so this is a no-op in that scope.
   *
   *  This is one of the two things that write `openSession` (the other is
   *  `startSession`). Nothing else does, which is what makes col 3 immune to
   *  every refresh path. */
  selectSession: (sessionId) => {
    const row = get().sessions.find((s) => s.id === sessionId)
    set({
      selectedSessionId: sessionId,
      openSession: snapshotOf(row, get().projects),
      ...(row?.project?.id ? { selectedProjectId: row.project.id } : {}),
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
    let state = null
    try {
      const data = await api(`/api/mission/sessions/${id}`)
      state = data.state || null
      // The user may have clicked another row while this was in flight.
      set((s) => (s.openSession?.id === id ? { sessionState: state } : s))
    } catch {
      set((s) => (s.openSession?.id === id ? { sessionState: null } : s))
      return null
    }
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
   *  is the only user action that legitimately empties the column. */
  closeSession: async (sessionId) => {
    await api(`/api/mission/sessions/${sessionId}`, { method: 'DELETE' })
    set((s) => (s.openSession?.id === sessionId ? { openSession: null, sessionState: null } : {}))
    await get().refreshActive()
  },

  toggleSessionLock: async (sessionId, locked) => {
    await api(`/api/mission/sessions/${sessionId}`, { method: 'PATCH', body: { locked } })
    await get().refreshActive()
  },

  createProject: async (payload) => {
    const data = await api('/api/mission/projects', { method: 'POST', body: payload })
    await get().fetchProjects()
    if (data?.project?.id) {
      // Selecting the new project makes it the col-1 selection, which is also
      // what `+ New session` targets in the 'all' scope — so a new project is
      // immediately usable there without switching scopes first.
      set({ selectedProjectId: data.project.id, selectedSessionId: '', sessions: [], history: null, loadedFor: '' })
      if (get().scope === 'all') get().fetchAll()
      else {
        get().fetchSessions(data.project.id)
        get().fetchHistory(data.project.id, get().includeSubfolders)
      }
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
      if (get().scope === 'all') get().fetchAll()
      else {
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
    set({ selectedSessionId: '', sessions: [], history: null, loadedFor: '' })
    await get().fetchProjects()
    // The aggregate list held rows from the project that is now gone; the
    // project list re-read above re-selects whatever exists, so re-read the
    // visible list too or col 2 would keep showing a project that is not there.
    if (get().scope === 'all') get().fetchAll()
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
}))
