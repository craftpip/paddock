import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'

export default function GlobalBackups() {
  const [backups, setBackups] = useState([])
  const [agents, setAgents] = useState([])
  const [msg, setMsg] = useState('')
  const navigate = useNavigate()

  function load() {
    api('/api/backups').then((d) => {
      if (d) setBackups(d.backups || d || [])
    }).catch(() => {})
    api('/api/agents').then((d) => {
      if (d?.agents) setAgents(d.agents)
    }).catch(() => {})
  }

  useEffect(load, [])

  async function quickBackup(name) {
    try {
      await api(`/api/agents/${name}/backups/create`, { method: 'POST' })
      setMsg(`Backup created for ${name}`)
      setTimeout(load, 1200)
    } catch (e) {
      setMsg('Backup failed: ' + (e.error || e.message))
    }
  }

  async function deleteBackup(file) {
    if (!confirm(`Delete ${file} permanently?`)) return
    try {
      await api('/api/agents/_/backups/delete', { method: 'POST', body: { file } })
      setMsg('Backup deleted')
      load()
    } catch (e) {
      setMsg('Delete failed: ' + (e.error || e.message))
    }
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Backups</h1>
        <span className="text-sm text-slate-400">{backups.length} backup{backups.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 mb-6">
        <div className="text-sm font-medium text-slate-300 mb-3">Quick Backup</div>
        <div className="flex flex-wrap gap-2">
          {agents.map((a) => (
            <button key={a.name} onClick={() => quickBackup(a.name)}
                    className="relative flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-slate-200 px-3 py-1.5 rounded-lg text-xs transition-colors">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${a.status === 'running' ? 'bg-emerald-400' : 'bg-slate-500'}`} />
              <span>{a.name}</span>
              <span className="text-slate-500">({a.agent_type})</span>
            </button>
          ))}
          {agents.length === 0 && <span className="text-xs text-slate-500">No agents found</span>}
        </div>
      </div>

      {msg && <div className="mb-4 text-xs text-cyan-400">{msg}</div>}

      {backups.length === 0 ? (
        <div className="text-center py-20 text-slate-500">
          <svg className="w-10 h-10 mx-auto mb-3 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" /></svg>
          <p className="text-lg font-semibold">No backups yet</p>
          <p className="text-sm mt-1">Use the quick backup buttons above or create one from an agent page.</p>
        </div>
      ) : (
        <div className="border border-slate-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left text-slate-500">
                  <th className="px-4 py-2.5 font-medium">Agent</th>
                  <th className="px-4 py-2.5 font-medium">Type</th>
                  <th className="px-4 py-2.5 font-medium">Created</th>
                  <th className="px-4 py-2.5 font-medium hidden sm:table-cell">Size</th>
                  <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => {
                  const isOrphan = !agents.find((a) => a.name === b.vm)
                  return (
                    <tr key={b.file || b.name} className="border-b border-slate-800/50 hover:bg-slate-800/30 group">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          {isOrphan && <span className="flex-shrink-0 w-2 h-2 rounded-full bg-amber-400" title="Agent not found" />}
                          <span className={isOrphan ? 'text-slate-500' : ''}>{b.vm}</span>
                          {isOrphan && <span className="inline-block bg-amber-900/40 text-amber-400 px-1.5 py-0.5 rounded text-[10px] font-medium">orphan</span>}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${b.type === 'picoclaw' ? 'bg-purple-900/50 text-purple-300' : 'bg-cyan-900/50 text-cyan-300'}`}>
                          {b.type === 'picoclaw' ? 'PicoClaw' : 'OpenClaw'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-col">
                          <span className="text-slate-300">{b.displayDate} <span className="text-slate-500">{b.displayTime}</span></span>
                          <span className="text-[11px] text-slate-600">{b.relativeTime}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-slate-500 hidden sm:table-cell">{b.size_hr}</td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1 opacity-40 group-hover:opacity-100 transition-opacity">
                          <button onClick={() => deleteBackup(b.file || b.name)}
                                  className="px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-slate-700 rounded transition-colors">Delete</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}
