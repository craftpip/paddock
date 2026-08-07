import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import { useToast } from '../lib/toast'
import { useConfirm } from '../lib/confirm'

const MASK = '••••••••••'
const PIN_RE = /^\d{4}$|^\d{6}$/

const inputCls = 'w-full bg-slate-950/60 border border-slate-600 rounded-lg px-2.5 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500'
const pinInputCls = 'w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:border-cyan-500 focus:outline-none tracking-[0.3em] text-center font-mono'

const LockIcon = ({ className = 'w-4 h-4' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
)

export default function Vault() {
  const toast = useToast()
  const confirm = useConfirm()
  const [items, setItems] = useState([])
  const [meta, setMeta] = useState({ pinSet: false, locked: false })
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState(null)
  const [form, setForm] = useState({ name: '', description: '', value: '' })
  const [saving, setSaving] = useState(false)

  // PIN gate for the current operation (asked at the moment of use — the vault
  // is otherwise always locked). null | { action: 'save'|'delete', item }
  const [pinPrompt, setPinPrompt] = useState(null)
  const [promptPin, setPromptPin] = useState('')
  const [promptErr, setPromptErr] = useState('')
  const [promptBusy, setPromptBusy] = useState(false)

  // set / reset PIN modal state
  const [pinModal, setPinModal] = useState(null) // null | 'set' | 'reset'
  const [pinForm, setPinForm] = useState({ pin: '', confirm: '', oldPin: '', password: '' })
  const [pinErr, setPinErr] = useState('')
  const [pinBusy, setPinBusy] = useState(false)

  function load() {
    api('/api/vault').then((d) => {
      setItems(d?.items || [])
      setMeta(d?.meta || { pinSet: false, locked: false })
    }).catch((err) => {
      toast.error('Failed to load vault: ' + (err.error || err.message))
    }).finally(() => setLoading(false))
  }

  useEffect(load, [])

  const editing = mode !== null
  const locked = meta.pinSet

  function cancel() {
    setMode(null)
    setForm({ name: '', description: '', value: '' })
  }

  function doAdd() {
    setMode('add')
    setForm({ name: '', description: '', value: '' })
  }

  function doEdit(item) {
    setMode(item.id)
    setForm({ name: item.name, description: item.description || '', value: '' })
  }

  function startAdd() {
    // First item on an unprotected vault → prompt to set a PIN first.
    if (!meta.pinSet && items.length === 0) {
      openPinModal('set')
      return
    }
    doAdd()
  }

  function startEdit(item) {
    doEdit(item)
  }

  async function doSave(pin) {
    const name = form.name.trim()
    setSaving(true)
    try {
      if (mode === 'add') {
        await api('/api/vault', { method: 'POST', body: { name, description: form.description, value: form.value.trim(), pin } })
        toast.success('Vault item added')
      } else {
        await api(`/api/vault/${mode}`, { method: 'PUT', body: { name, description: form.description, value: form.value.trim(), pin } })
        toast.success('Vault item updated')
      }
      cancel()
      load()
    } finally {
      setSaving(false)
    }
  }

  function handleSave() {
    if (!form.name.trim()) return toast.error('Name is required')
    if (mode === 'add' && !form.value.trim()) return toast.error('Value is required')
    if (locked) return requireUnlock('save')
    doSave().catch((err) => toast.error((err.error || err.message) || 'Failed to save vault item'))
  }

  async function doDelete(item, pin) {
    await api(`/api/vault/${item.id}`, { method: 'DELETE', body: { pin } })
    toast.success('Vault item deleted')
    if (mode === item.id) cancel()
    load()
  }

  async function handleDelete(item) {
    const ok = await confirm({
      title: 'Delete vault item',
      message: `Delete vault item '${item.name}'? This cannot be undone.`,
      danger: true,
      confirmText: 'Delete',
    })
    if (!ok) return
    if (locked) return requireUnlock('delete', item)
    doDelete(item).catch((err) => toast.error((err.error || err.message) || 'Failed to delete vault item'))
  }

  function requireUnlock(action, item) {
    setPromptPin('')
    setPromptErr('')
    setPinPrompt({ action, item })
  }

  function cancelPinPrompt() {
    setPinPrompt(null)
    setPromptPin('')
    setPromptErr('')
  }

  async function submitPinPrompt() {
    if (!PIN_RE.test(promptPin)) return setPromptErr('PIN must be 4 or 6 digits')
    setPromptBusy(true)
    setPromptErr('')
    const { action, item } = pinPrompt
    const pin = promptPin
    try {
      if (action === 'save') await doSave(pin)
      else if (action === 'delete') await doDelete(item, pin)
      setPinPrompt(null)
      setPromptPin('')
    } catch (err) {
      setPromptErr(err.error || err.message || 'Wrong PIN')
    } finally {
      setPromptBusy(false)
    }
  }

  function openPinModal(m) {
    setPinModal(m)
    setPinForm({ pin: '', confirm: '', oldPin: '', password: '' })
    setPinErr('')
  }

  function closePinModal() {
    setPinModal(null)
  }

  async function handlePinSubmit() {
    const pin = pinForm.pin
    if (!PIN_RE.test(pin)) return setPinErr('PIN must be 4 or 6 digits')
    if (pin !== pinForm.confirm) return setPinErr('PINs do not match')
    if (pinModal === 'reset' && !PIN_RE.test(pinForm.oldPin)) return setPinErr('Current PIN must be 4 or 6 digits')
    if (pinModal === 'reset' && !pinForm.password) return setPinErr('Your password is required to reset')
    setPinBusy(true)
    setPinErr('')
    try {
      await api('/api/vault/pin', {
        method: 'POST',
        body: {
          pin,
          reset: pinModal === 'reset',
          oldPin: pinModal === 'reset' ? pinForm.oldPin : undefined,
          password: pinModal === 'reset' ? pinForm.password : undefined,
        },
      })
      toast.success(pinModal === 'reset' ? 'PIN reset — vault items erased' : 'PIN set')
      setPinModal(null)
      load()
    } catch (err) {
      setPinErr(err.error || err.message || 'Failed to set PIN')
    } finally {
      setPinBusy(false)
    }
  }

  function digitsOnly(e) {
    return e.target.value.replace(/\D/g, '').slice(0, 6)
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Vault</h1>
          {!loading && (meta.pinSet ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-amber-400 bg-amber-950/50 border border-amber-700/50 px-2 py-0.5 rounded-full">
              <LockIcon className="w-3 h-3" /> locked
            </span>
          ) : (
            <span className="text-[11px] text-slate-500 bg-slate-800 px-2 py-0.5 rounded-full">encrypted key-value store</span>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {!loading && (meta.pinSet ? (
            <button onClick={() => openPinModal('reset')}
                    className="text-slate-400 hover:text-amber-300 hover:bg-slate-800 px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap">
              Change PIN
            </button>
          ) : (
            <button onClick={() => openPinModal('set')}
                    className="text-cyan-400 hover:text-cyan-300 hover:bg-cyan-950/40 px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap flex items-center gap-1.5">
              <LockIcon className="w-4 h-4" />
              Set PIN
            </button>
          ))}
        </div>
      </div>

      {!loading && !meta.pinSet && items.length === 0 && !editing && (
        <div className="mb-6 bg-amber-950/30 border border-amber-800/40 rounded-xl px-5 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <LockIcon className="w-6 h-6 text-amber-400 shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-200">Your vault is unprotected</p>
              <p className="text-xs text-amber-400/80 mt-0.5">Set a 4 or 6 digit PIN — the vault will lock and you'll need the PIN to open it.</p>
            </div>
          </div>
          <button onClick={() => openPinModal('set')}
                  className="bg-amber-700 hover:bg-amber-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap">
            Set PIN
          </button>
        </div>
      )}

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
                    <td className="py-2.5 px-3 font-mono text-xs text-slate-500">
                      <span className="inline-flex items-center gap-1.5">
                        <LockIcon className="w-3 h-3 text-amber-500/80 shrink-0" />
                        {MASK}
                      </span>
                    </td>
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

      {pinPrompt && (
        <PinPromptModal
          action={pinPrompt.action}
          item={pinPrompt.item}
          pin={promptPin}
          setPin={setPromptPin}
          error={promptErr}
          busy={promptBusy}
          digitsOnly={digitsOnly}
          onCancel={cancelPinPrompt}
          onSubmit={submitPinPrompt}
        />
      )}

      {pinModal && (
        <PinModal
          mode={pinModal}
          form={pinForm}
          setForm={setPinForm}
          error={pinErr}
          busy={pinBusy}
          digitsOnly={digitsOnly}
          onCancel={closePinModal}
          onSubmit={handlePinSubmit}
        />
      )}
    </div>
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
        <button onClick={onSave} disabled={saving} className="mr-2 bg-cyan-700 hover:bg-cyan-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
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

function PinModal({ mode, form, setForm, error, busy, digitsOnly, onCancel, onSubmit }) {
  const isReset = mode === 'reset'
  function set(k, v) {
    setForm((f) => ({ ...f, [k]: v }))
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') onCancel()
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <div role="dialog" aria-modal="true" className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <form onSubmit={(e) => { e.preventDefault(); onSubmit() }}>
          <div className="px-6 pt-5 pb-3">
            <h3 className={`text-base font-semibold ${isReset ? 'text-red-400' : 'text-slate-100'}`}>
              {isReset ? 'Reset vault PIN' : 'Set vault PIN'}
            </h3>
            {isReset ? (
              <div className="mt-2 text-sm text-red-300/90 leading-relaxed whitespace-pre-wrap">
                This will <b>permanently erase ALL vault items</b>. Enter your password and current PIN to confirm.
              </div>
            ) : (
              <div className="mt-2 text-sm text-slate-400 leading-relaxed">
                Choose a 4 or 6 digit PIN. Values are encrypted at rest and you'll enter your PIN each time you add, edit, delete, or use an item.
              </div>
            )}
          </div>
          <div className="px-6 pb-4 space-y-4">
            {isReset && (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Current PIN</label>
                  <input
                    type="password"
                    inputMode="numeric"
                    value={form.oldPin}
                    onChange={(e) => set('oldPin', digitsOnly(e))}
                    placeholder="••••••"
                    autoComplete="current-password"
                    className={pinInputCls}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Your password</label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => set('password', e.target.value)}
                    placeholder="dashboard login password"
                    autoComplete="current-password"
                    className={pinInputCls}
                  />
                </div>
              </>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">New PIN</label>
              <input
                type="password"
                inputMode="numeric"
                value={form.pin}
                onChange={(e) => set('pin', digitsOnly(e))}
                placeholder="••••••"
                autoFocus={!isReset}
                autoComplete="new-password"
                className={pinInputCls}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Confirm PIN</label>
              <input
                type="password"
                inputMode="numeric"
                value={form.confirm}
                onChange={(e) => set('confirm', digitsOnly(e))}
                placeholder="••••••"
                autoComplete="new-password"
                className={pinInputCls}
              />
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
          </div>
          <div className="flex items-center justify-end gap-3 px-6 pb-5 pt-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="px-4 py-2 text-sm font-medium text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-50 ${
                isReset ? 'bg-red-600 hover:bg-red-500' : 'bg-cyan-600 hover:bg-cyan-500'
              }`}
            >
              {busy ? (isReset ? 'Resetting…' : 'Setting…') : (isReset ? 'Erase & reset' : 'Set PIN')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function PinPromptModal({ action, item, pin, setPin, error, busy, digitsOnly, onCancel, onSubmit }) {
  function onKeyDown(e) {
    if (e.key === 'Escape') onCancel()
  }
  const verbs = { save: 'save your changes', delete: `delete '${item?.name}'` }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <div role="dialog" aria-modal="true" className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <form onSubmit={(e) => { e.preventDefault(); onSubmit() }}>
          <div className="px-6 pt-5 pb-3 flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-amber-900/40 border border-amber-700/40 flex items-center justify-center shrink-0">
              <LockIcon className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-100">Vault is locked</h3>
              <div className="mt-1 text-sm text-slate-400 leading-relaxed">
                Enter your PIN to {verbs[action] || 'use the vault'}.
              </div>
            </div>
          </div>
          <div className="px-6 pb-4">
            <input
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => { setPin(digitsOnly(e)); }}
              placeholder="••••••"
              autoFocus
              autoComplete="current-password"
              className={pinInputCls}
            />
            {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
          </div>
          <div className="flex items-center justify-end gap-3 px-6 pb-5 pt-1">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="px-4 py-2 text-sm font-medium text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 text-sm font-medium text-white bg-cyan-600 hover:bg-cyan-500 rounded-lg transition-colors disabled:opacity-50"
            >
              {busy ? 'Unlocking…' : 'Unlock & continue'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
