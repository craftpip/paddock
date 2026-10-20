import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigation, useDirtyNavigation, useDraftState, popupIdentity } from '../lib/navigation'
import { SECTIONS, PROMPT_KEYS, CALLBACK_KEYS } from '../lib/url-state'
import { cx } from '../lib/cx'
import { useMission } from '../stores/mission'
import { useAgents } from '../stores/agents'
import Button from './ui/Button'
import Choice from './ui/Choice'
import { Input, Select, Textarea } from './ui/Input'
import Switch from './ui/Switch'
import { TONES } from './ui/tone'
import SettingsDialog from './SettingsDialog'
import PromptTemplateEditor from './PromptTemplateEditor'
import CallbackScriptEditor, { CallbackKindTabs } from './CallbackScriptEditor'

function useCodingAgents() {
  const agents = useAgents((s) => s.agents)
  return useMemo(
    () => agents.filter((a) => a.mission?.supported || ['opencode', 'codex', 'claude'].includes(a.agent_type)),
    [agents]
  )
}

// Plan 91 §Phase 3: when each prompt is sent, in the user's terms. Shown
// beside the kind selector; the engine contract (below the editor) says what
// prompt edits can and cannot change.
const KIND_EXPLANATIONS = {
  start: 'Sent once when you press Run on a paused runner with pending work.',
  resume: 'Sent instead of Start when resuming after a current-task pause — continues the same plan from its checkpoint.',
  continue: 'Sent automatically while Running once the worker is confirmed idle and grace plus interval have elapsed.',
  recovery: 'Sent when the supervisor recreates a dead worker pane in the same conversation.',
  pause: 'Sent once when you choose Pause current task — asks the worker to stop at a checkpoint.',
}
const KIND_ORDER = ['start', 'resume', 'continue', 'recovery', 'pause']

export default function RunnerDialog({ runner, project, session, onClose }) {
  const { location, patch, drafts: memory } = useNavigation()
  const params = new URLSearchParams(location.search)
  const section = SECTIONS.includes(params.get('section')) ? params.get('section') : 'settings'
  const kind = PROMPT_KEYS.includes(params.get('prompt')) ? params.get('prompt') : 'continue'
  const cbKind = CALLBACK_KEYS.includes(params.get('event')) ? params.get('event') : 'init'
  const setSection = (v) => patch({ section: v, prompt: v === 'prompts' ? kind : null, event: v === 'callbacks' ? cbKind : null })
  const setKind = (v) => patch({ section: 'prompts', prompt: v, event: null })
  const setCbKind = (v) => patch({ section: 'callbacks', event: v, prompt: null })
  const draftPrefix = `runner:${runner?.id || `${project?.id}:${session?.id || 'new'}`}:`
  const saved = useRef(false)
  const clearDrafts = () => { for (const key of memory.keys()) if (key.startsWith(draftPrefix)) memory.delete(key) }
  const editing = !!runner
  const allAgents = useCodingAgents()
  const {
    createRunner, updateRunner, removeRunner, getRunner, getRunnerQueue, updateRunnerQueueCustomInstructions, runners, fetchOpenRunnerQueue,
    getPromptConfig, getProjectPromptCatalogue, previewRunnerPrompts, previewProjectPrompts,
    getRunnerCallbacks, saveRunnerCallbacks, getRunnerCallbackHistory, getProjectCallbackCatalogue,
  } = useMission()
  // Resolve the CURRENT record by ID (plan 85 §Phase 3): the prop is captured
  // at open time and goes stale the moment a queue action lands. Settings save
  // against the id either way; the displayed state follows the store.
  const [fresh, setFresh] = useState(runner || null)
  useEffect(() => {
    if (!runner?.id) return
    let live = true
    getRunner(runner.id).then((r) => { if (live) setFresh(r) }).catch(() => {})
    return () => { live = false }
  }, [runner?.id, getRunner])
  const current = fresh || runner
  // Sessions of THIS project only — the picker must not offer a conversation
  // from another project, and must not re-offer one already bound to a runner
  // (the runner row IS that session now). The table is a small, already-loaded
  // list; no fetch needed here.
  const projectSessions = useMission((s) => s.sessions)
  const eligibleSessions = useMemo(() => {
    const pid = String(project?.id || '')
    const bound = new Set(runners.filter((r) => r.id !== runner?.id && r.session_id).map((r) => r.session_id))
    return projectSessions.filter(
      (s) => String(s.project_id || '') === pid && s.agent_session_id && !bound.has(s.id)
    )
  }, [project?.id, projectSessions, runners, runner?.id])

  // Worker-session binding (plan 85): a new infinite session gets a REAL
  // session at create time — "New session" mints one now, it does not wait for
  // the first Run. "Use an existing session" converts a live row (reached from
  // the ∞ button, which passes that session in here) and keeps its row,
  // conversation and terminal identity.
  const [useExisting, setUseExisting] = useDraftState(draftPrefix + 'existing', !!(runner?.session_id || session?.id))
  const [name, setName] = useDraftState(draftPrefix + 'name', runner?.name || '')
  const [sessionId, setSessionId] = useDraftState(draftPrefix + 'session', runner?.session_id || session?.id || '')
  const [idleGraceMs, setIdleGraceMs] = useDraftState(draftPrefix + 'idle', runner?.idle_grace_ms || 120000)
  const [minNudgeIntervalMs, setMinNudgeIntervalMs] = useDraftState(draftPrefix + 'interval', runner?.min_nudge_interval_ms || 120000)
  const [noProgressBudget, setNoProgressBudget] = useDraftState(draftPrefix + 'budget', runner?.no_progress_budget || 3)
  const [compactionGraceMs, setCompactionGraceMs] = useDraftState(draftPrefix + 'compaction', runner?.compaction_grace_ms || 300000)
  const [longCommandThresholdMs, setLongCommandThresholdMs] = useDraftState(draftPrefix + 'long', runner?.long_command_threshold_ms || 1800000)
  const [recoverExited, setRecoverExited] = useDraftState(draftPrefix + 'recover', runner?.recover_exited ?? true)
  const [recoveryBudget, setRecoveryBudget] = useDraftState(draftPrefix + 'recoveryBudget', runner?.recovery_budget || 3)
  const [queueFile, setQueueFile] = useDraftState(draftPrefix + 'queueFile', runner?.queue_file || 'QUEUE.md')
  const [customInstructions, setCustomInstructions] = useDraftState(draftPrefix + 'customInstructions', '')
  const [initialCustomInstructions, setInitialCustomInstructions] = useState('')
  const [customRevision, setCustomRevision] = useState(null)
  const [loadedQueueFile, setLoadedQueueFile] = useState(null)
  const [customLoadError, setCustomLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [actionBusy, setActionBusy] = useState(null)
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    if (!editing || !current?.id || loadedQueueFile === queueFile || memory.has(draftPrefix + 'customInstructions')) return
    let live = true
    getRunnerQueue(current.id).then((data) => {
      if (!live) return
      setCustomInstructions(data.queue?.customInstructions || '')
      setInitialCustomInstructions(data.queue?.customInstructions || '')
      setCustomRevision(data.queue?.revision || null)
      setLoadedQueueFile(queueFile)
      setCustomLoadError(data.queue?.condition === 'ok' || data.queue?.condition === 'missing' ? '' : data.queue?.error || 'Could not load custom instructions')
    }).catch((e) => { if (live) setCustomLoadError(e?.error || e?.message || 'Could not load custom instructions') })
    return () => { live = false }
  }, [editing, current?.id, queueFile, loadedQueueFile, getRunnerQueue, memory, draftPrefix, setCustomInstructions])

  // ── Prompts section (plan 91 §Phase 3) ──────────────────────────────
  // Drafts are keyed by dispatch kind and initialized from the runner's
  // effective set (edit) or the shipped defaults (create). The server is the
  // validation authority: the active kind auto-previews (debounced) through
  // the preview route, and Save stays disabled while that preview is pending,
  // errored or stale. Nothing here sends, starts a session or touches queue
  // state — preview and save are both side-effect free by server contract.
  const [catalogue, setCatalogue] = useState(null) // { keys, catalogue, limits, defaults }
  const [configError, setConfigError] = useState('')
  const [initialDrafts, setInitialDrafts] = useState(null)
  const [drafts, setDrafts] = useDraftState(draftPrefix + 'prompts', null)
  const [kindErrors, setKindErrors] = useState({}) // kind -> [{ message, line, column }]
  const [previews, setPreviews] = useState({}) // kind -> { text, sources } | { pending: true }
  const [previewedValues, setPreviewedValues] = useState({}) // kind -> source text last previewed
  const [resetAllArmed, setResetAllArmed] = useDraftState(draftPrefix + 'resetPrompts', false)
  const previewTimer = useRef(null)
  const previewsRef = useRef(previews)
  previewsRef.current = previews
  const previewedValuesRef = useRef(previewedValues)
  previewedValuesRef.current = previewedValues

  useEffect(() => {
    let live = true
    const load = async () => {
      try {
        if (editing && runner?.id) {
          const cfg = await getPromptConfig(runner.id)
          if (!live) return
          setCatalogue({ keys: cfg.keys, catalogue: cfg.catalogue, limits: cfg.limits, defaults: cfg.defaults })
          const eff = cfg.error ? cfg.defaults : (cfg.effective || cfg.defaults)
          setInitialDrafts({ ...eff })
           if (!memory.has(draftPrefix + 'prompts')) setDrafts({ ...eff })
          if (cfg.error) setConfigError(`Saved prompts are misconfigured (${cfg.error.code}): editing starts from the shipped defaults. Saving repairs the configuration.`)
        } else if (project?.id) {
          const cat = await getProjectPromptCatalogue(project.id)
          if (!live) return
          setCatalogue({ keys: cat.keys, catalogue: cat.catalogue, limits: cat.limits, defaults: cat.defaults })
          setInitialDrafts({ ...cat.defaults })
           if (!memory.has(draftPrefix + 'prompts')) setDrafts({ ...cat.defaults })
        }
      } catch (e) {
        if (live) setConfigError(e?.error || e?.message || 'Could not load prompt configuration')
      }
    }
    load()
    return () => { live = false }
  }, [editing, runner?.id, project?.id, getPromptConfig, getProjectPromptCatalogue])

  // Debounced server preview of the ACTIVE kind. Fires on kind switch and
  // 400ms after the draft stops changing; a newer edit cancels the in-flight
  // timer (the fetch itself is cheap and read-only, so no abort needed).
  //
  // previews/previewedValues are read through refs and deliberately NOT in the
  // dep array: setting `pending` here must not re-run this effect, because its
  // own cleanup would then clear the 400ms timer before it ever fires (the
  // preview was stuck "Rendering…" forever and Save stayed disabled). Only
  // kind/drafts/catalogue and identity changes reschedule a preview.
  useEffect(() => {
    if (!drafts || !catalogue) return
    const value = drafts[kind]
    if (value === undefined) return
    const seen = previewedValuesRef.current[kind]
    const cur = previewsRef.current[kind]
    if (seen === value && cur && !cur.pending) return
    setPreviews((p) => ({ ...p, [kind]: { pending: true } }))
    clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(async () => {
      try {
        const call = editing && runner?.id
          ? previewRunnerPrompts(runner.id, { [kind]: value }, {})
          : previewProjectPrompts(project?.id, { [kind]: value }, { runner_name: name.trim() || 'New runner' })
        const res = await call
        setPreviews((p) => ({ ...p, [kind]: res.ok ? { text: res.rendered[kind], sources: res.contextSources } : { pending: false } }))
        setPreviewedValues((p) => ({ ...p, [kind]: value }))
        setKindErrors((e) => ({ ...e, [kind]: res.ok ? [] : res.errors.filter((x) => x.key === kind) }))
      } catch (e) {
        setPreviews((p) => ({ ...p, [kind]: { pending: false } }))
        setPreviewedValues((p) => ({ ...p, [kind]: value }))
        setKindErrors((e) => ({ ...e, [kind]: [{ message: e?.error || e?.message || 'Preview failed' }] }))
      }
    }, 400)
    return () => clearTimeout(previewTimer.current)
  }, [kind, drafts, catalogue, editing, runner?.id, project?.id, name, previewRunnerPrompts, previewProjectPrompts])

  const promptsDirty = !!drafts && !!initialDrafts && (resetAllArmed || KIND_ORDER.some((k) => drafts[k] !== initialDrafts[k]))
  const activePreview = previews[kind]
  const activeStale = drafts && previewedValues[kind] !== drafts[kind]
  const promptsInvalid = KIND_ORDER.some((k) => (kindErrors[k] || []).length > 0)
    || !!activePreview?.pending || !!activeStale

  // ── Callbacks section (plan 92 §Phase 4) ───────────────────────────
  // Drafts keyed by event ({ script, enabled }), initialized from saved
  // settings (edit) or empty+disabled (create). Validation mirrors the
  // server rule (enabled needs a non-empty script) so Save disables with an
  // explanation; the server enforces it anyway. Saving never executes — the
  // script runs only when its event fires (init/destroy are wired; see the
  // notice in the section), so enabling arms the event, it does not run it.
  const [cbCatalogue, setCbCatalogue] = useState(null) // { events, envVars, limits }
  const [cbConfigError, setCbConfigError] = useState('')
  const [cbInitial, setCbInitial] = useState(null)
  const [cbDrafts, setCbDrafts] = useDraftState(draftPrefix + 'callbacks', null)
  const [cbErrors, setCbErrors] = useState({}) // event -> [{ message }]
  const [cbHistory, setCbHistory] = useState([])
  const cbKeys = useMemo(() => (cbCatalogue?.events || []).map((e) => e.key), [cbCatalogue])

  useEffect(() => {
    let live = true
    const load = async () => {
      try {
        if (editing && runner?.id) {
          const data = await getRunnerCallbacks(runner.id)
          if (!live) return
          setCbCatalogue({ events: data.catalogue.events, envVars: data.catalogue.envVars, limits: data.catalogue.limits, environment: data.catalogue.environment || null })
          const drafts = {}
          for (const c of data.callbacks) drafts[c.event] = { script: c.script || '', enabled: !!c.enabled, recreateResume: !!c.recreateResume }
          setCbInitial(drafts)
           if (!memory.has(draftPrefix + 'callbacks')) setCbDrafts(drafts)
        } else if (project?.id) {
          const cat = await getProjectCallbackCatalogue(project.id)
          if (!live) return
          setCbCatalogue({ events: cat.events, envVars: cat.envVars, limits: cat.limits, environment: cat.environment || null })
          const drafts = {}
          for (const e of cat.events) drafts[e.key] = { script: '', enabled: false }
          setCbInitial(drafts)
           if (!memory.has(draftPrefix + 'callbacks')) setCbDrafts(drafts)
        }
      } catch (e) {
        if (live) setCbConfigError(e?.error || e?.message || 'Could not load callback configuration')
      }
    }
    load()
    return () => { live = false }
  }, [editing, runner?.id, project?.id, getRunnerCallbacks, getProjectCallbackCatalogue])

  // Recent executions for the open runner (empty until the Phase 3 executor
  // exists). Loaded when the section opens so the list never pays for it.
  useEffect(() => {
    if (section !== 'callbacks' || !editing || !runner?.id) return
    let live = true
    getRunnerCallbackHistory(runner.id)
      .then((data) => { if (live) setCbHistory(data.history || []) })
      .catch(() => {})
    return () => { live = false }
  }, [section, editing, runner?.id, getRunnerCallbackHistory])

  const cbDirtyKinds = useMemo(() => {
    if (!cbDrafts || !cbInitial) return []
    return Object.keys(cbDrafts).filter((k) =>
      !cbInitial[k] || cbDrafts[k].script !== cbInitial[k].script || !!cbDrafts[k].enabled !== !!cbInitial[k].enabled || !!cbDrafts[k].recreateResume !== !!cbInitial[k].recreateResume)
  }, [cbDrafts, cbInitial])
  const cbInvalid = useMemo(() => {
    const bad = {}
    if (cbDrafts) {
      for (const k of Object.keys(cbDrafts)) {
        if (cbDrafts[k].enabled && !cbDrafts[k].script.trim()) {
          bad[k] = [{ message: `Callback \`${k}\` is enabled but its script is empty.` }]
        }
      }
    }
    return bad
  }, [cbDrafts])
  const cbDirty = cbDirtyKinds.length > 0
  const latestResultFor = (event) => cbHistory.find((h) => h.event === event) || null
  const settingsSnapshot = useMemo(() => JSON.stringify({
    name, sessionId, idleGraceMs, minNudgeIntervalMs, noProgressBudget,
    compactionGraceMs, longCommandThresholdMs, recoverExited, recoveryBudget, queueFile, useExisting,
  }), [name, sessionId, idleGraceMs, minNudgeIntervalMs, noProgressBudget, compactionGraceMs, longCommandThresholdMs, recoverExited, recoveryBudget, queueFile, useExisting])
  const initialSettings = useMemo(() => JSON.stringify({
    name: runner?.name || '', sessionId: runner?.session_id || session?.id || '',
    idleGraceMs: runner?.idle_grace_ms || 120000, minNudgeIntervalMs: runner?.min_nudge_interval_ms || 120000,
    noProgressBudget: runner?.no_progress_budget || 3, compactionGraceMs: runner?.compaction_grace_ms || 300000,
    longCommandThresholdMs: runner?.long_command_threshold_ms || 1800000,
    recoverExited: runner?.recover_exited ?? true, recoveryBudget: runner?.recovery_budget || 3,
    queueFile: runner?.queue_file || 'QUEUE.md',
    useExisting: !!(runner?.session_id || session?.id),
  }), [runner, session])
  const customDirty = customInstructions !== initialCustomInstructions
  const dirty = settingsSnapshot !== initialSettings || customDirty || promptsDirty || cbDirty
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  useEffect(() => () => { if (!dirtyRef.current) clearDrafts() }, [])
  useDirtyNavigation(() => dirty && !saved.current, popupIdentity, clearDrafts)

  const previewNow = async () => {
    if (!drafts) return
    const value = drafts[kind]
    setPreviews((p) => ({ ...p, [kind]: { pending: true } }))
    try {
      const res = editing && runner?.id
        ? await previewRunnerPrompts(runner.id, { [kind]: value }, {})
        : await previewProjectPrompts(project?.id, { [kind]: value }, { runner_name: name.trim() || 'New runner' })
      setPreviews((p) => ({ ...p, [kind]: res.ok ? { text: res.rendered[kind], sources: res.contextSources } : { pending: false } }))
      setPreviewedValues((p) => ({ ...p, [kind]: value }))
      setKindErrors((e) => ({ ...e, [kind]: res.ok ? [] : res.errors.filter((x) => x.key === kind) }))
    } catch (e) {
      setPreviews((p) => ({ ...p, [kind]: { pending: false } }))
      setKindErrors((e2) => ({ ...e2, [kind]: [{ message: e?.error || e?.message || 'Preview failed' }] }))
    }
  }

  const canSave = name.trim() && !busy && !customLoadError && !promptsInvalid && Object.keys(cbInvalid).length === 0

  const submit = async (e) => {
    e.preventDefault()
    if (!canSave) return
    setBusy(true)
    setError('')
    try {
      // Plan 91: saving edits never dispatches — updateRunner writes settings
      // columns only, and the full draft set (or an explicit null reset) rides
      // along only when the Prompts section is dirty. Omitted on a clean edit
      // so untouched custom sets are preserved byte for byte.
      let promptTemplates
      if (editing) {
        promptTemplates = resetAllArmed ? null : (promptsDirty ? { ...drafts } : undefined)
      } else {
        promptTemplates = promptsDirty && !resetAllArmed ? { ...drafts } : undefined
      }
      const payload = {
        projectId: project?.id || undefined,
        name: name.trim(),
        sessionId: sessionId || undefined,
        idleGraceMs: Number(idleGraceMs),
        minNudgeIntervalMs: Number(minNudgeIntervalMs),
        noProgressBudget: Number(noProgressBudget),
        compactionGraceMs: Number(compactionGraceMs),
        longCommandThresholdMs: Number(longCommandThresholdMs),
        recoverExited,
        recoveryBudget: Number(recoveryBudget),
        queueFile,
        promptTemplates,
      }
      const savedRunner = editing
        ? await updateRunner(current.id, payload)
        : await createRunner(payload)
      if (customDirty) {
        try {
          await updateRunnerQueueCustomInstructions(savedRunner.id, customInstructions, customRevision)
        } catch (queueError) {
          setError(`Settings saved, but custom instructions were not: ${queueError?.error || queueError?.message || 'unknown error'}. Reload or review the queue before retrying; your draft is kept.`)
          return
        }
      }
      if (editing && current.id) await fetchOpenRunnerQueue()
      // Plan 92 §Phase 4: callback drafts save only when dirty, and only the
      // changed events (omitted events preserve their saved values). Saving
      // never executes a script.
      if (cbDirty && cbDrafts && savedRunner?.id) {
        const map = {}
        for (const k of cbDirtyKinds) map[k] = { script: cbDrafts[k].script, enabled: !!cbDrafts[k].enabled, recreateResume: !!cbDrafts[k].recreateResume }
        try {
          await saveRunnerCallbacks(savedRunner.id, map)
        } catch (cerr) {
          // Settings already saved; callbacks did not — stay open and say
          // exactly that instead of closing over a half-saved dialog.
          const cm = /Callback `(\w+)`/.exec(cerr?.error || cerr?.message || '')
          if (cm) {
            setCbKind(cm[1])
            setCbErrors((prev) => ({ ...prev, [cm[1]]: [{ message: cerr.error || cerr.message }] }))
          }
          setError(`Settings saved, but callbacks were not: ${cerr?.error || cerr?.message || 'unknown error'}`)
          return
        }
      }
      saved.current = true
      clearDrafts()
      onClose({ saved: true })
    } catch (err) {
      // A server-side template rejection names its kind (`Template `x`:`) —
      // pin it on that kind's editor as well as the form bar.
      const m = /Template `(\w+)`/.exec(err?.error || err?.message || '')
      if (m && KIND_ORDER.includes(m[1])) {
        setKind(m[1])
        setKindErrors((prev) => ({ ...prev, [m[1]]: [{ message: err.error || err.message }] }))
      }
      setError(err?.error || err?.message || 'Could not save the runner')
    } finally {
      setBusy(false)
    }
  }

  // Plan 85 §Phase 3: Run/Pause live in the session's terminal header, not in
  // settings. The dialog keeps only the destructive action (Remove), whose
  // place is a config surface — and it resolves the id fresh, never from a
  // captured row.
  const handleRemove = async () => {
    setActionBusy(current.id)
    setActionError('')
    try {
      await removeRunner(current.id)
      saved.current = true
      clearDrafts()
      onClose({ saved: true })
    } catch (err) {
      setActionError(err?.error || err?.message || 'Could not remove runner')
    } finally {
      setActionBusy(null)
    }
  }

  const canRemove = editing

  return (
    <SettingsDialog
      title={editing ? `Runner: ${current.name}` : 'New infinite runner'}
      sections={[{ id: 'settings', label: 'Settings' }, { id: 'prompts', label: 'Prompts' }, { id: 'callbacks', label: 'Callbacks' }]}
      section={section}
      onSection={setSection}
       dirty={false}
      onClose={onClose}
      footer={(
        <>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} className="msn-btn-cancel">
            Cancel
          </Button>
          <Button
            type="submit"
            form="msn-runner-form"
            variant="primary"
            size="sm"
            disabled={!canSave}
            loading={busy}
            className="msn-btn-submit"
            title={!name.trim() ? 'Name the runner first' : promptsInvalid ? 'Fix the prompt errors (or wait for preview) before saving' : Object.keys(cbInvalid).length ? 'An enabled callback needs a non-empty script' : undefined}
          >
            {busy ? 'Saving…' : editing ? 'Save' : 'Create runner'}
          </Button>
        </>
      )}
    >
      <form id="msn-runner-form" onSubmit={submit} className="msn-dialog-form flex flex-col gap-3">
        {section === 'settings' && (
          <>
            <label className="msn-field msn-field-name flex flex-col gap-1">
              <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Name</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My runner"
                autoFocus={!editing}
                className="msn-input-name"
              />
            </label>

            <label className="msn-field msn-field-queue-file flex flex-col gap-1">
              <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Queue file</span>
              <Input
                value={queueFile}
                onChange={(e) => setQueueFile(e.target.value)}
                placeholder="QUEUE.md"
                className="msn-input-queue-file"
              />
              <span className="msn-field-note text-[11px] text-ink-dim">
                Relative to {project?.plans_folder || 'plans'} in {project?.name || 'the project'}. Leave blank for QUEUE.md.
              </span>
            </label>

            <label className="msn-field msn-field-custom-instructions flex flex-col gap-1">
              <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Custom instructions</span>
              <Textarea value={customInstructions} onChange={(e) => setCustomInstructions(e.target.value)} className="msn-input-custom-instructions" placeholder="Optional queue-level guidance" />
              <span className="msn-field-note text-[11px] text-ink-dim">Optional guidance for the agent working this queue. Saved in the queue file.</span>
              {customLoadError && <span className="text-[11px] text-danger">{customLoadError} Reload or repair the queue before saving; this draft will not overwrite it.</span>}
              {loadedQueueFile && loadedQueueFile !== queueFile && <span className="text-[11px] text-warning">This is a draft from {loadedQueueFile}. Review it before saving to {queueFile || 'QUEUE.md'}.</span>}
              {loadedQueueFile && loadedQueueFile !== queueFile && <Button type="button" variant="ghost" size="sm" onClick={() => { memory.delete(draftPrefix + 'customInstructions'); setInitialCustomInstructions(''); setLoadedQueueFile(null); setCustomLoadError('') }}>Discard draft and load saved instructions</Button>}
            </label>

            {!editing && (
              <div className="msn-field msn-field-session flex flex-col gap-1">
                <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Worker session</span>
                <div className="flex gap-2">
                  <Choice
                    selected={!useExisting}
                    onClick={() => {
                      setUseExisting(false)
                      setSessionId('')
                    }}
                    size="sm"
                    className="msn-worker-choice msn-worker-choice-new"
                  >
                    New session
                  </Choice>
                  <Choice
                    selected={useExisting}
                    onClick={() => setUseExisting(true)}
                    size="sm"
                    className="msn-worker-choice msn-worker-choice-existing"
                  >
                    Use an existing session
                  </Choice>
                </div>
                {useExisting && (
                  <Select
                    size="sm"
                    value={sessionId}
                    onChange={(e) => setSessionId(e.target.value)}
                    className="msn-select-worker"
                  >
                    <option value="">Pick a conversation…</option>
                    {eligibleSessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title || s.label || s.tmux_id}
                      </option>
                    ))}
                  </Select>
                )}
                <span className="msn-field-note text-[11px] text-ink-dim">
                  {useExisting
                    ? 'The runner will re-use this conversation — it keeps running where that session left off.'
                    : 'A fresh session opens now, with its own terminal. Its queue stays paused until you press Run.'}
                </span>
              </div>
            )}

            <div className="msn-field msn-field-timing flex flex-col gap-1">
              <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Timing</span>
              <div className="grid grid-cols-2 gap-2">
                <label className="msn-field msn-field-idle flex flex-col gap-1">
                  <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Idle grace (ms)</span>
                  <Input
                    type="number"
                    min="1000"
                    value={idleGraceMs}
                    onChange={(e) => setIdleGraceMs(e.target.value)}
                    className="msn-input-idle"
                  />
                </label>
                <label className="msn-field msn-field-nudge flex flex-col gap-1">
                  <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Min nudge interval (ms)</span>
                  <Input
                    type="number"
                    min="1000"
                    value={minNudgeIntervalMs}
                    onChange={(e) => setMinNudgeIntervalMs(e.target.value)}
                    className="msn-input-nudge"
                  />
                </label>
                <label className="msn-field msn-field-budget flex flex-col gap-1">
                  <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Nudge budget</span>
                  <Input
                    type="number"
                    min="1"
                    max="10"
                    value={noProgressBudget}
                    onChange={(e) => setNoProgressBudget(e.target.value)}
                    className="msn-input-budget"
                  />
                </label>
                <label className="msn-field msn-field-compaction flex flex-col gap-1">
                  <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Compaction grace (ms)</span>
                  <Input
                    type="number"
                    min="1000"
                    value={compactionGraceMs}
                    onChange={(e) => setCompactionGraceMs(e.target.value)}
                    className="msn-input-compaction"
                  />
                </label>
                <label className="msn-field msn-field-long flex flex-col gap-1">
                  <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Long command threshold (ms)</span>
                  <Input
                    type="number"
                    min="60000"
                    value={longCommandThresholdMs}
                    onChange={(e) => setLongCommandThresholdMs(e.target.value)}
                    className="msn-input-long"
                  />
                </label>
                <label className="msn-field msn-field-recovery flex flex-col gap-1">
                  <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Recovery budget</span>
                  <Input
                    type="number"
                    min="1"
                    max="10"
                    value={recoveryBudget}
                    onChange={(e) => setRecoveryBudget(e.target.value)}
                    className="msn-input-recovery"
                  />
                </label>
              </div>
            </div>

            <div className="msn-field msn-field-recovery flex items-center gap-2">
              <Switch
                checked={recoverExited}
                onChange={setRecoverExited}
                id="msn-recover-exited"
              />
              <label htmlFor="msn-recover-exited" className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                Recover exited worker
              </label>
            </div>

            {editing && canRemove && (
              <div className="msn-runner-actions border-t border-line-faint pt-2 mt-2">
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={handleRemove}
                    loading={actionBusy === current.id}
                    className="msn-btn-runner-remove"
                  >
                    Remove as runner
                  </Button>
                </div>
                {actionError && (
                  <p className={cx('msn-error-bar rounded-control border px-3 py-2 text-xs', TONES.danger.panel)}>{actionError}</p>
                )}
              </div>
            )}
          </>
        )}

        {section === 'prompts' && (
          <div className="msn-runner-prompts flex flex-col gap-2">
            <p className="msn-field-note text-[11px] text-ink-dim">
              Prompt edits change the LLM's instructions only. Queue validation, pause/lock/permission
              gates, dispatch ownership and idle eligibility stay enforced no matter the wording.
              A running runner uses saved templates only for its next eligible dispatch — saving never
              nudges, restarts or resends.
            </p>
            {configError && (
              <p className={cx('msn-error-bar rounded-control border px-3 py-2 text-xs', TONES.danger.panel)}>{configError}</p>
            )}
            {!drafts || !catalogue ? (
              <p className="msn-prompts-loading text-[11px] text-ink-dim">Loading prompt configuration…</p>
            ) : (
              <>
                <div role="tablist" aria-label="Prompt kinds" className="msn-prompt-kinds flex flex-wrap gap-1">
                  {KIND_ORDER.map((k) => (
                    <Button
                      key={k}
                      type="button"
                      variant={kind === k ? 'primary' : 'secondary'}
                      size="sm"
                      role="tab"
                      aria-selected={kind === k}
                      onClick={() => setKind(k)}
                      title={KIND_EXPLANATIONS[k]}
                      className="msn-prompt-kind"
                    >
                      {k === 'continue' ? 'Continue / idle nudge' : k[0].toUpperCase() + k.slice(1)}
                      {(kindErrors[k] || []).length > 0 && ' ⚠'}
                      {drafts[k] !== initialDrafts[k] && ' •'}
                    </Button>
                  ))}
                </div>
                <p className="msn-prompt-kind-explains text-[11px] text-ink-dim">{KIND_EXPLANATIONS[kind]}</p>
                <div className="flex flex-col gap-2 md:flex-row">
                  <PromptTemplateEditor
                    id={`prompt-${kind}`}
                    value={drafts[kind] || ''}
                    onChange={(v) => {
                      setDrafts((d) => ({ ...d, [kind]: v }))
                      setResetAllArmed(false)
                    }}
                    catalogue={catalogue.catalogue}
                    errors={kindErrors[kind] || []}
                    preview={activePreview?.pending ? { pending: true } : (previews[kind]?.text != null ? previews[kind] : null)}
                    onPreview={previewNow}
                    onReset={() => {
                      setDrafts((d) => ({ ...d, [kind]: catalogue.defaults[kind] }))
                      setResetAllArmed(false)
                    }}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDrafts({ ...catalogue.defaults })
                      setResetAllArmed(true)
                    }}
                    className="msn-prompt-reset-all"
                    title="Reset the whole saved set to the shipped defaults on Save (a deliberate separate action)"
                  >
                    Reset all prompts
                  </Button>
                  {resetAllArmed && (
                    <span className="text-[11px] text-ink-dim">Will reset to shipped defaults on Save.</span>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {section === 'callbacks' && (
          <div className="msn-runner-callbacks flex flex-col gap-2">
            <p className="msn-field-note text-[11px] text-ink-dim">
              Callback scripts run in a system shell, outside the LLM conversation — never
              typed into the worker's terminal. Saving never executes a script; a script
              runs only when its event fires.
            </p>
            {cbConfigError && (
              <p className={cx('msn-error-bar rounded-control border px-3 py-2 text-xs', TONES.danger.panel)}>{cbConfigError}</p>
            )}
            {!cbDrafts || !cbCatalogue ? (
              <p className="msn-callbacks-loading text-[11px] text-ink-dim">Loading callback configuration…</p>
            ) : (
              <>
                <CallbackKindTabs
                  kinds={cbKeys}
                  kind={cbKind}
                  onKind={setCbKind}
                  errors={Object.fromEntries(cbKeys.map((k) => [k, [...(cbErrors[k] || []), ...(cbInvalid[k] || []).map((e) => ({ message: e.message }))]]))}
                  dirtyKinds={cbDirtyKinds}
                />
                <p className="msn-callback-kind-explains text-[11px] text-ink-dim">
                  {(cbCatalogue.events.find((e) => e.key === cbKind) || {}).meaning || ''}
                </p>
                <div className="flex flex-col gap-2 md:flex-row">
                  <CallbackScriptEditor
                    eventKey={cbKind}
                    meaning={(cbCatalogue.events.find((e) => e.key === cbKind) || {}).meaning || ''}
                    value={(cbDrafts[cbKind] || {}).script || ''}
                    onChange={(v) => setCbDrafts((d) => ({ ...d, [cbKind]: { ...d[cbKind], script: v } }))}
                    enabled={!!(cbDrafts[cbKind] || {}).enabled}
                    recreateResume={!!(cbDrafts[cbKind] || {}).recreateResume}
                    onRecreateResumeChange={(next) => setCbDrafts((d) => ({ ...d, [cbKind]: { ...d[cbKind], recreateResume: next } }))}
                    onEnabledChange={(next) => setCbDrafts((d) => ({ ...d, [cbKind]: { ...d[cbKind], enabled: next } }))}
                    envVars={cbCatalogue.envVars || []}
                    environment={cbCatalogue.environment || null}
                    result={latestResultFor(cbKind)}
                  />
                </div>
                {((cbErrors[cbKind] || []).length > 0 || (cbInvalid[cbKind] || []).length > 0) && (
                  <ul className="msn-callback-errors flex flex-col gap-1">
                    {[...(cbErrors[cbKind] || []), ...(cbInvalid[cbKind] || [])].map((e, i) => (
                      <li key={i} className="msn-callback-error rounded-control border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] text-danger">
                        {e.message}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}

        {error && (
          <p className={cx('msn-error-bar rounded-control border px-3 py-2 text-xs', TONES.danger.panel)}>{error}</p>
        )}
      </form>
    </SettingsDialog>
  )
}
