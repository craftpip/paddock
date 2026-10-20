import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { parsePopups } from '../lib/url-state'
import { useNavigation } from '../lib/navigation'
import ProjectDialog from './ProjectDialog'
import RunnerDialog from './RunnerDialog'
import Modal from './ui/Modal'
import Button from './ui/Button'
import { useToast } from '../lib/toast'
import { useMission } from '../stores/mission'

// All entry points (rows/header/direct links) resolve the same authorized data.
export default function MissionPopups() {
  const toast = useToast()
  const openRunnerId = useMission((s) => s.openSession?.runner?.id || '')
  const viewLoading = useMission((s) => s.viewLoading)
  const { location, closePopup } = useNavigation()
  const popup = parsePopups(location.search, location.pathname).at(-1)
  const descriptor = popup?.value || ''
  const [result, setResult] = useState(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let live = true
    setResult(null)
    if (!popup || !['project-new', 'project-edit', 'runner-new', 'runner-convert', 'runner-settings'].includes(popup.type)) return
    const load = async () => {
      try {
        let project, runner, session
        if (popup.type === 'project-new') project = null
        else if (popup.type === 'runner-settings') {
          runner = (await api(`/api/mission/runners/${encodeURIComponent(popup.args[0])}`)).runner
          project = (await api(`/api/mission/projects/${encodeURIComponent(runner.project_id)}`)).project
        } else {
          project = (await api(`/api/mission/projects/${encodeURIComponent(popup.args[0])}`)).project
          if (popup.type === 'runner-convert') {
            session = (await api(`/api/mission/sessions/${encodeURIComponent(popup.args[1])}`)).session
            if (session.project_id !== project.id) throw { error: 'This session belongs to another project.' }
          }
        }
        if (live) setResult({ descriptor, project, runner, session })
      } catch (e) {
        if (live && [403, 404].includes(e?.status)) {
          toast.error(e?.error || 'This popup target is unavailable.')
          closePopup({ saved: true, expected: descriptor })
          return
        }
        if (live) setResult({ descriptor, error: e?.error || e?.message || 'Could not load this popup', unavailable: [403, 404].includes(e?.status) })
      }
    }
    load()
    return () => { live = false }
  }, [descriptor, retry])
  if (popup && ['queue-add', 'queue-resolve'].includes(popup.type) && !viewLoading && popup.args[0] !== openRunnerId) return (
    <Modal title="Queue view unavailable" onClose={() => closePopup()}>
      Open this runner's session before using its queue dialog. This link does not start a worker.
    </Modal>
  )
  if (!popup || !['project-new', 'project-edit', 'runner-new', 'runner-convert', 'runner-settings'].includes(popup.type)) return null
  if (!result || result.descriptor !== descriptor || result.error) return (
    <Modal title={result?.error ? 'View unavailable' : 'Loading…'} onClose={() => closePopup()}>
      {result?.descriptor === descriptor && result.error ? <><p>{result.error}</p>{!result.unavailable && <Button onClick={() => setRetry((n) => n + 1)}>Retry</Button>}</> : 'Loading saved configuration…'}
    </Modal>
  )
  return popup.type.startsWith('project-')
    ? <ProjectDialog key={descriptor} project={result.project} onClose={(options) => closePopup({ ...options, expected: descriptor })} />
    : <RunnerDialog key={descriptor} runner={result.runner} project={result.project} session={result.session} onClose={(options) => closePopup({ ...options, expected: descriptor })} />
}
