import { useState, useEffect } from 'react'
import { useDirtyNavigation } from '../../lib/navigation'
import { api } from '../../lib/api'
import Button from '../../components/ui/Button'
import { Textarea } from '../../components/ui/Input'

export default function ConfigTab({ agent }) {
  const [raw, setRaw] = useState('')
  const [saved, setSaved] = useState(true)
  const [msg, setMsg] = useState('')
  const [configFile, setConfigFile] = useState('config.json')
  const [configFormat, setConfigFormat] = useState('json')
  useDirtyNavigation(!saved, (l) => l.pathname)

  useEffect(() => {
    api(`/api/agents/${agent.name}/config`).then((d) => {
      if (d.configFile) setConfigFile(d.configFile)
      if (d.configFormat) setConfigFormat(d.configFormat)
      if (d.configRaw) { setRaw(d.configRaw); setSaved(true) }
    }).catch(() => {})
  }, [agent.name])

  async function handleSave() {
    try {
      if (configFormat === 'json') JSON.parse(raw)
      await api(`/api/agents/${agent.name}/config`, { method: 'POST', body: { config: raw } })
      setSaved(true)
      setMsg('Configuration saved. Restart the agent to apply.')
    } catch (err) {
      // A failed api() call rejects with { status, error }, not an Error: reading
      // only .message turned every server refusal into "Invalid JSON".
      setMsg(err?.error || err?.message || 'Could not save the configuration')
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-medium text-ink-muted">Agent Configuration</h3>
          <p className="text-xs text-ink-dim">{configFile}{configFormat !== 'json' ? ` (${configFormat})` : ''}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs ${saved ? 'text-ink-dim' : 'text-warning'}`}>{saved ? 'Saved' : 'Unsaved changes'}</span>
          <Button variant="primary" size="md" onClick={handleSave}>
            Save
          </Button>
        </div>
      </div>
      {msg && <div className="mb-4 text-xs text-accent-text">{msg}</div>}
      <Textarea
        mono
        value={raw}
        onChange={(e) => { setRaw(e.target.value); setSaved(false); setMsg('') }}
        className="h-[500px] text-xs resize-none"
        spellCheck={false}
      />
    </div>
  )
}
