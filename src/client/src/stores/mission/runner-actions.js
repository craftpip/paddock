import { api } from '../../lib/api'
import { errText } from './shared'

// Every queue endpoint answers with the envelope `{ runner, project, queue,
// updatedAt }` (plan 86 §Phase 1); the panel renders the inner `queue`. Accept a
// bare queue object too, so the store is not coupled to the envelope's wrapper.
function queueOf(data) {
  return data && typeof data === 'object' && data.queue ? data.queue : data
}

// Guards the runner listing against out-of-order fetches: a project response
// that lands after a scope switch must not overwrite the new scope's rows.
let runnerToken = 0

// Guards the open runner's QUEUE read (plan 86 §Phase 2): the queue must follow
// col 3, so when the open session changes while a read is in flight the stale
// answer must not become the new conversation's queue. Module scope like the
// other tokens — per page load, not per component.
let queueToken = 0

/** Runner and queue actions of the Mission store: listing runners, the open session's queue and its edits, start / pause / resume, prompts and callbacks. */
export function runnerActions(set, get) {
  return {
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
  }
}
