import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import { useToast } from '../lib/toast'

const MASK = '••••••••••'

const inputCls = 'w-full bg-slate-950/60 border border-slate-600 rounded-lg px-2.5 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500'

export default function Vault() {
  const toast = useToast()
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState(null)
  const [form, setForm] = useState({ name: '', description: '', value: '' })
  const [saving, setSaving] = useState(false)

  function load() {
    api('/api/vault').then((d) => {
      setItems(d?.items || [])
    }).catch((err) => {
      toast.error('Failed to load vault: ' + (err.error || err.message))
    }).finally(() => setLoading(false))
  }

  useEffect(load, [])

  const editing = mode !== null

  function cancel() {
    setMode(null)
    setForm({ name: '', description: '', value: '' })
  }

  function startAdd() {
    setMode('add')
    setForm({ name: '', description: '', value: '' })
  }

  function startEdit(item) {
    setMode(item.id)
    setForm({ name: item.name, description: item.description || '', value: '' })
  }

  async function handleSave() {
    const name = form.name.trim()
    if (!name) return toast.error('Name is required')
    if (mode === 'add' && !form.value.trim()) return toast.error('Value is required')
    setSaving(true)
    try {
      if (mode === 'add') {
        await api('/api/vault', { method: 'POST', body: { name, description: form.description, value: form.value.trim() } })
        toast.success('Vault item added')
      } else {
        await api(`/api/vault/${mode}`, { method: 'PUT', body: { name, description: form.description, value: form.value.trim() } })
        toast.success('Vault item updated')
      }
      cancel()
      load()
    } catch (err) {
      toast.error((err.error || err.message) || 'Failed to save vault item')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(item) {
    if (!confirm(`Delete vault item '${item.name}'? This cannot be undone.`)) return
    try {
      await api(`/api/vault/${item.id}`, { method: 'DELETE' })
      toast.success('Vault item deleted')
      if (mode === item.id) cancel()
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
        <div className="px-5 py-4 border-b border-slate-700/60 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Vault items</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Values are encrypted at rest and never shown again after saving.
            </p>
          </div>
          {!editing && (
            <button onClick={startAdd}
                    className="bg-cyan-700 hover:bg-cyan-600 text-white px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors flex items-center gap-1.5">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
              Add item
            </button>
          )}
        </div>
        <div className="p-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-slate-500 border-b border-slate-700/60">
                <th className="text-left font-medium py-2.5 px-3 w-[22%]">Name</th>
                <th className="text-left font-medium py-2.5 px-3">Description</th>
                <th className="text-left font-medium py-2.5 px-3 w-[18%]">Value</th>
                <th className="text-left font-medium py-2.5 px-3 w-[16%]">Updated</th>
                <th className="text-right font-medium py-2.5 px-3 w-[150px]"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/40">
              {mode === 'add' && (
                <EditorRow form={form} setForm={setForm} isNew saving={saving} onSave={handleSave} onCancel={cancel} />
              )}
              {!loading && !editing && items.length === 0 && (
                <tr><td colSpan={5} className="py-8 text-center text-sm text-slate-600">No vault items yet</td></tr>
              )}
              {items.map((item) =>
                mode === item.id ? (
                  <EditorRow key={item.id} form={form} setForm={setForm} isNew={false} saving={saving} onSave={handleSave} onCancel={cancel} />
                ) : (
                  <tr key={item.id} className={`transition-colors ${editing ? 'opacity-40 pointer-events-none' : 'hover:bg-slate-700/30'}`}>
                    <td className="py-2.5 px-3 font-medium text-slate-200">{item.name}</td>
                    <td className="py-2.5 px-3 text-slate-400 text-sm">{item.description || <span className="text-slate-600">—</span>}</td>
                    <td className="py-2.5 px-3 font-mono text-xs text-slate-500">{MASK}</td>
                    <td className="py-2.5 px-3 text-xs text-slate-500">{item.updated_at}</td>
                    <td className="py-2.5 px-3 text-right whitespace-nowrap">
                      <button onClick={() => startEdit(item)} className="text-cyan-400 hover:text-cyan-300 hover:bg-cyan-950/30 px-2 py-1 rounded transition-colors text-xs font-medium">Edit</button>
                      <button onClick={() => handleDelete(item)} className="text-red-400 hover:text-red-300 hover:bg-red-950/30 px-2 py-1 rounded transition-colors text-xs font-medium">Delete</button>
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

function EditorRow({ form, setForm, isNew, saving, onSave, onCancel }) {
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  return (
    <tr className="bg-cyan-950/20">
      <td className="py-2 px-3">
        <input type="text" value={form.name} onChange={set('name')} placeholder="e.g. openrouter_key"
               onKeyDown={(e) => e.key === 'Enter' && onSave()}
               className={inputCls} />
      </td>
      <td className="py-2 px-3">
        <input type="text" value={form.description} onChange={set('description')} placeholder="what this is for"
               onKeyDown={(e) => e.key === 'Enter' && onSave()}
               className={inputCls} />
      </td>
      <td className="py-2 px-3">
        <input type="password" value={form.value} onChange={set('value')}
               placeholder={isNew ? 'sk-...' : 'leave blank to keep existing'}
               autoComplete="new-password"
               onKeyDown={(e) => e.key === 'Enter' && onSave()}
               className={`${inputCls} font-mono`} />
      </td>
      <td className="py-2 px-3 text-xs text-slate-600">{isNew ? '—' : ''}</td>
      <td className="py-2 px-3 text-right whitespace-nowrap">
        <button onClick={onSave} disabled={saving}
                className="bg-cyan-700 hover:bg-cyan-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
          {saving ? 'Saving…' : isNew ? 'Add' : 'Save'}
        </button>
        <button onClick={onCancel} disabled={saving}
                className="bg-slate-700 hover:bg-slate-600 text-slate-200 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
          Cancel
        </button>
      </td>
    </tr>
  )
}
