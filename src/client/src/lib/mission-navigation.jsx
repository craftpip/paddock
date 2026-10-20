import { useEffect, useRef, useState } from 'react'
import { useNavigationType } from 'react-router-dom'
import { useMission } from '../stores/mission'
import { useNavigation } from './navigation'
import { missionView, canonicalMissionSearch } from './url-state'

export function useMissionNavigation() {
  const { location, patch } = useNavigation()
  const origin = useNavigationType()
  const initialized = useRef(false)
  const ready = useRef(false)
  const [hydrated, setHydrated] = useState(false)
  const lastView = useRef('')
  const view = missionView(location.search)
  const viewKey = JSON.stringify(view)
  useEffect(() => {
    const navigateView = (intent, options = {}) => {
      const values = {}
      if ('project' in intent) Object.assign(values, { project: intent.project, view: intent.project ? 'project' : 'all' })
      if ('subfolders' in intent) values.subfolders = intent.subfolders ? '1' : null
      if ('session' in intent) Object.assign(values, { session: intent.session, conversation: null, terminalProject: null })
      if (intent.closedSession) {
        if (new URLSearchParams(location.search).get('session') !== intent.closedSession) return
        Object.assign(values, { session: null, conversation: intent.conversation || null, terminalProject: intent.terminalProject || null })
      }
      patch(values, { replace: !!options.replace, explicitOpen: options.explicitOpen ? intent.session : '' })
    }
    useMission.setState({ navigateView })
    return () => useMission.setState({ navigateView: null })
  }, [location.search, patch])
  useEffect(() => {
    const canonical = canonicalMissionSearch(location.search)
    if (canonical !== location.search) {
      const p = new URLSearchParams(canonical)
      const old = new URLSearchParams(location.search)
      const values = {}
      for (const key of ['project', 'view', 'session', 'conversation', 'terminalProject', 'subfolders', 'queue', 'section', 'prompt', 'event']) {
        if (old.has(key)) values[key] = p.get(key)
      }
      patch(values, { replace: true })
      return
    }
    if (!initialized.current) {
      initialized.current = true
      if (!location.search && !location.state?.navigated) {
        const previous = useMission.getState().persistedView
        patch({ project: previous.selectedProjectId, view: previous.selectedProjectId ? 'project' : 'all', session: previous.openSession?.id || null }, { replace: true })
        return
      }
    }
    if (lastView.current === viewKey && ready.current) return
    lastView.current = viewKey
    let live = true
    useMission.getState().restoreView(view, { fresh: !ready.current, autoReopen: origin === 'PUSH' && location.state?.explicitOpen === view.session })
      .then(() => { if (live) { ready.current = true; setHydrated(true) } })
    return () => { live = false }
  }, [viewKey, location.search, location.state, origin, patch])
  return { ...useNavigation(), view, hydrated }
}
