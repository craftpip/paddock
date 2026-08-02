import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import { useToast } from '../lib/toast'

const MASK = '••••••••••'

export default function Vault() {
  const toast = useToast()
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [value, setValue] = useState('')

  function load() {
    api('/api/vault').then((d) => {
      setItems(d?.items || [])
    }).catch((err) => {
      toast.error('Failed to load vault: ' + (err.error || err.message))
    }).finally(() => setLoading(false))
  }

  useEffect(load, [])

  function resetForm() {
    setEditingId(null)
    setName('')
    setDescription('')
    setValue('')
  }

  function startEdit(item) {
    setEditingId(item.id)
    setName(item.name)
    setDescription(item.description || '')
    setValue('')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) return toast.error('Name is required')
    if (!editingId && !value.trim()) return toast.error('Value is required')
    try {
      if (editingId) {
        await api(`/api/vault/${editingId}`, { method: 'PUT', body: { name: name.trim(), description, value: value.trim() } })
        toast.success('Vault item updated')
      } else {
        await api('/api/vault', { method: 'POST', body: { name: name.trim(), description, value: value.trim() } })
        toast.success('Vault item added')
      }
      resetForm()
      load()
    } catch (err) {
      toast.error((err.error || err.message) || 'Failed to save vault item')
    }
  }

  async function handleDelete(item) {
    if (!confirm(`Delete vault item '${item.name}'? This cannot be undone.`)) return
    try {
      await api(`/api/vault/${item.id}`, { method: 'DELETE' })
      toast.success('Vault item deleted')
      if (editingId === item.id) resetForm()
      load()
    } catch (err) {
      toast.error((err.error || err.message) || 'Failed to delete vault item')
    }
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Vault</h1>
          <span className="text-[11px] text-slate-500 bg-slate-800 px-2 py-0.5 rounded-full">encrypted key-value store</span>
        </div>
      </div>

      <div className="bg-slate-800/50 border border-slate-700/60 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-700/60">
          <h2 className="text-base font-semibold text-slate-100">{editingId ? 'Edit Vault Item' : 'Add Vault Item'}</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Values are encrypted at rest and never shown again after saving.
          </p>
        </div>
        <div className="p-5">
          <form onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-[1fr_1.5fr_1fr_auto] gap-3 mb-5 items-end">
            <div>
              <label className="block text-[11px] font-medium text-slate-500 mb-1">Name</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. openrouter_key" required
                     className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500" />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-500 mb-1">Description <span className="text-slate-600">(optional)</span></label>
              <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="what this is for"
                     className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500" />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-500 mb-1">Value</label>
              <input type="password" value={value} onChange={(e) => setValue(e.target.value)} required={!editingId}
                     placeholder={editingId ? 'leave blank to keep existing' : 'sk-...'}
                     autoComplete="new-password"
                     className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500 font-mono" />
            </div>
            <div className="flex items-center gap-2">
              <button type="submit" className="bg-cyan-700 hover:bg-cyan-600 text-white px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
                {editingId ? 'Save' : 'Add'}
              </button>
              {editingId && (
                <button type="button" onClick={resetForm}
                        className="bg-slate-700 hover:bg-slate-600 text-slate-200 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors">
                  Cancel
                </button>
              )}
            </div>
          </form>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-slate-500 border-b border-slate-700/60">
                <th className="text-left font-medium py-2.5 px-3 w-[22%]">Name</th>
                <th className="text-left font-medium py-2.5 px-3">Description</th>
                <th className="text-left font-medium py-2.5 px-3 w-[18%]">Value</th>
                <th className="text-left font-medium py-2.5 px-3 w-[16%]">Updated</th>
                <th className="text-right font-medium py-2.5 px-3 w-[110px]"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/40">
              {!loading && items.length === 0 && (
                <tr><td colSpan={5} className="py-8 text-center text-sm text-slate-600">No vault items yet</td></tr>
              )}
              {items.map((item) => (
                <tr key={item.id} className={`hover:bg-slate-700/30 transition-colors ${editingId === item.id ? 'bg-slate-700/20' : ''}`}>
                  <td className="py-2.5 px-3 font-medium text-slate-200">{item.name}</td>
                  <td className="py-2.5 px-3 text-slate-400 text-sm">{item.description || <span className="text-slate-600">—</span>}</td>
                  <td className="py-2.5 px-3 font-mono text-xs text-slate-500">{MASK}</td>
                  <td className="py-2.5 px-3 text-xs text-slate-500">{item.updated_at}</td>
                  <td className="py-2.5 px-3 text-right whitespace-nowrap">
                    <button onClick={() => startEdit(item)} className="text-cyan-400 hover:text-cyan-300 hover:bg-cyan-950/30 px-2 py-1 rounded transition-colors text-xs font-medium">Edit</button>
                    <button onClick={() => handleDelete(item)} className="text-red-400 hover:text-red-300 hover:bg-red-950/30 px-2 py-1 rounded transition-colors text-xs font-medium">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
