import { useState, useEffect } from 'react'
import { useNavigation, useDirtyNavigation, popupIdentity } from '../lib/navigation'
import { parsePopups } from '../lib/url-state'
import { api } from '../lib/api'
import { useToast } from '../lib/toast'
import { useConfirm } from '../lib/confirm'
import Button from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import Field from '../components/ui/Field'
import Card from '../components/ui/Card'
import Badge from '../components/ui/Badge'
import Modal from '../components/ui/Modal'
import { TONES } from '../components/ui/tone'
import { cx } from '../lib/cx'

const MASK = '••••••••••'
const PIN_RE = /^\d{4}$|^\d{6}$/

/* the PIN fields keep the centred wide-tracking look they always had */
const pinFieldCls = 'text-center tracking-[0.3em]'

const LockIcon = ({ className = 'w-4 h-4' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
)

export default function Vault() {
  const { location, openPopup, closePopup, drafts } = useNavigation()
  const popup = parsePopups(location.search, location.pathname).at(-1)
  const toast = useToast()
  const confirm = useConfirm()
  const [items, setItems] = useState([])
  const [meta, setMeta] = useState({ pinSet: false, locked: false })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const mode = popup?.type === 'vault-add' ? 'add' : popup?.type === 'vault-edit' ? popup.args[0] : null
  const setMode = (value) => value === null ? closePopup() : value === 'add' ? openPopup('vault-add') : openPopup('vault-edit', String(value))
  const [form, setFormState] = useState({ name: '', description: '', value: '' })
  const [saving, setSaving] = useState(false)

  // PIN gate for the current operation (asked at the moment of use — the vault
  // is otherwise always locked). null | { action: 'save'|'delete', item }
  const [pinPrompt, setPinPrompt] = useState(null)
  const [promptPin, setPromptPin] = useState('')
  const [promptErr, setPromptErr] = useState('')
  const [promptBusy, setPromptBusy] = useState(false)

  // set / reset PIN modal state
  const pinModal = popup?.type === 'vault-pin' ? popup.args[0] : null
  const setPinModal = (value) => value === null ? closePopup() : openPopup('vault-pin', value)
  const [pinForm, setPinForm] = useState({ pin: '', confirm: '', oldPin: '', password: '' })
  const [pinErr, setPinErr] = useState('')
  const [pinBusy, setPinBusy] = useState(false)
  useEffect(() => {
    setPinForm({ pin: '', confirm: '', oldPin: '', password: '' })
    setPinErr('')
  }, [pinModal])
  const formKey = `vault:${mode}`
  const setForm = (next) => setFormState((old) => {
    const value = typeof next === 'function' ? next(old) : next
    if (mode) drafts.set(formKey, value)
    return value
  })
  const baseline = mode === 'add' ? { name: '', description: '' } : items.find((it) => String(it.id) === mode)
  const dirty = !!mode && !!baseline && (form.name !== baseline.name || form.description !== (baseline.description || '') || !!form.value)
  useDirtyNavigation(dirty || (pinModal && Object.values(pinForm).some(Boolean)), popupIdentity, () => {
    drafts.delete(formKey); setFormState({ name: '', description: '', value: '' }); setPinForm({ pin: '', confirm: '', oldPin: '', password: '' })
  })
  useEffect(() => {
    if (!mode || loading) return
    const item = items.find((it) => String(it.id) === mode)
    if (mode !== 'add' && !item) return
    setFormState(drafts.get(formKey) || { name: item?.name || '', description: item?.description || '', value: '' })
  }, [mode, loading])

  function load() {
    api('/api/vault').then((d) => {
      setLoadError('')
      setItems(d?.items || [])
      setMeta(d?.meta || { pinSet: false, locked: false })
    }).catch((err) => {
      setLoadError(err.error || err.message || 'Failed to load vault')
      toast.error('Failed to load vault: ' + (err.error || err.message))
    }).finally(() => setLoading(false))
  }

  useEffect(load, [])

  const editing = mode !== null
  const locked = meta.pinSet
  useEffect(() => {
    if (!loading && !loadError && mode && mode !== 'add' && !items.some((it) => String(it.id) === mode)) {
      toast.error('This vault item is unavailable.')
      closePopup({ saved: true, expected: popup?.value })
    }
  }, [loading, loadError, mode, items])

  function cancel() {
    closePopup()
  }

  function doAdd() {
    setMode('add')
  }

  function doEdit(item) {
    setMode(item.id)
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
      drafts.delete(formKey)
      closePopup({ saved: true, expected: popup?.value })
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
    if (String(mode) === String(item.id)) closePopup({ saved: true, expected: popup?.value })
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
      setPinForm({ pin: '', confirm: '', oldPin: '', password: '' })
      closePopup({ saved: true, expected: popup?.value })
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
            <Badge tone="warning" className="border border-warning-line/50">
              <LockIcon className="w-3 h-3" /> locked
            </Badge>
          ) : (
            <Badge>encrypted key-value store</Badge>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {!loading && (meta.pinSet ? (
            <Button variant="ghost" className="text-ink-faint hover:text-warning" onClick={() => openPinModal('reset')}>
              Change PIN
            </Button>
          ) : (
            <Button variant="accentGhost" onClick={() => openPinModal('set')}>
              <LockIcon />
              Set PIN
            </Button>
          ))}
        </div>
      </div>

      {!loading && !meta.pinSet && items.length === 0 && !editing && (
        <div className={cx('mb-6 rounded-card border px-5 py-4 flex items-center justify-between gap-4', TONES.warning.panel)}>
          <div className="flex items-center gap-3">
            <LockIcon className="w-6 h-6 text-warning shrink-0" />
            <div>
              <p className="text-sm font-medium text-warning">Your vault is unprotected</p>
              <p className="text-xs text-warning/80 mt-0.5">Set a 4 or 6 digit PIN — the vault will lock and you'll need the PIN to open it.</p>
            </div>
          </div>
          <Button variant="primary" className="bg-warning-soft hover:bg-warning text-warning hover:text-warning-ink"
                  onClick={() => openPinModal('set')}>
            Set PIN
          </Button>
        </div>
      )}

      {loadError && <p className="mb-3 text-sm text-danger">{loadError} <Button onClick={load}>Retry</Button></p>}
      <Card className="overflow-hidden">
        <div className="px-5 py-4 border-b border-line/60 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-ink">Vault items</h2>
            <p className="text-xs text-ink-dim mt-0.5">
              Values are encrypted at rest and never shown again after saving.
            </p>
          </div>
          {!editing && (
            <Button variant="accentGhost" className="bg-accent-soft hover:bg-accent hover:text-accent-ink" onClick={startAdd}>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
              Add item
            </Button>
          )}
        </div>
        <div className="p-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-ink-dim border-b border-line/60">
                <th className="text-left font-medium py-2.5 px-3 w-[22%]">Name</th>
                <th className="text-left font-medium py-2.5 px-3">Description</th>
                <th className="text-left font-medium py-2.5 px-3 w-[18%]">Value</th>
                <th className="text-left font-medium py-2.5 px-3 w-[16%]">Updated</th>
                <th className="text-right font-medium py-2.5 px-3 w-[150px]"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/40">
              {mode === 'add' && (
                <EditorRow form={form} setForm={setForm} isNew saving={saving} onSave={handleSave} onCancel={cancel} />
              )}
              {!loading && !editing && items.length === 0 && (
                <tr><td colSpan={5} className="py-8 text-center text-sm text-ink-dim">No vault items yet</td></tr>
              )}
              {items.map((item) =>
                mode === String(item.id) ? (
                  <EditorRow key={item.id} form={form} setForm={setForm} isNew={false} saving={saving} onSave={handleSave} onCancel={cancel} />
                ) : (
                  <tr key={item.id} className={`transition-colors ${editing ? 'opacity-40 pointer-events-none' : 'hover:bg-raised/30'}`}>
                    <td className="py-2.5 px-3 font-medium text-ink">{item.name}</td>
                    <td className="py-2.5 px-3 text-ink-faint text-sm">{item.description || <span className="text-ink-dim">—</span>}</td>
                    <td className="py-2.5 px-3 font-mono text-xs text-ink-dim">
                      <span className="inline-flex items-center gap-1.5">
                        <LockIcon className="w-3 h-3 text-warning/80 shrink-0" />
                        {MASK}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-xs text-ink-dim">{item.updated_at}</td>
                    <td className="py-2.5 px-3 text-right whitespace-nowrap">
                      <Button variant="accentGhost" size="sm" onClick={() => startEdit(item)}>Edit</Button>
                      <Button variant="dangerGhost" size="sm" onClick={() => handleDelete(item)}>Delete</Button>
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      </Card>

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
    <tr className="bg-accent-soft">
      <td className="py-2 px-3">
        <Input type="text" value={form.name} onChange={set('name')} placeholder="e.g. openrouter_key"
               onKeyDown={(e) => e.key === 'Enter' && onSave()} />
      </td>
      <td className="py-2 px-3">
        <Input type="text" value={form.description} onChange={set('description')} placeholder="what this is for"
               onKeyDown={(e) => e.key === 'Enter' && onSave()} />
      </td>
      <td className="py-2 px-3">
        <Input type="password" value={form.value} onChange={set('value')} mono
               placeholder={isNew ? 'sk-...' : 'leave blank to keep existing'}
               autoComplete="new-password"
               onKeyDown={(e) => e.key === 'Enter' && onSave()} />
      </td>
      <td className="py-2 px-3 text-xs text-ink-dim">{isNew ? '—' : ''}</td>
      <td className="py-2 px-3 text-right whitespace-nowrap">
        <Button variant="accentGhost" size="sm" onClick={onSave} disabled={saving}
                className="mr-2 bg-accent-soft hover:bg-accent hover:text-accent-ink">
          {saving ? 'Saving…' : isNew ? 'Add' : 'Save'}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </td>
    </tr>
  )
}

function PinModal({ mode, form, setForm, error, busy, digitsOnly, onCancel, onSubmit }) {
  const isReset = mode === 'reset'
  function set(k, v) {
    setForm((f) => ({ ...f, [k]: v }))
  }
  return (
    <Modal
      open
      onClose={onCancel}
      title={isReset ? 'Reset vault PIN' : 'Set vault PIN'}
      tone={isReset ? 'danger' : undefined}
    >
      {/* The submit button stays INSIDE the form, so Enter-to-submit works. */}
      <form onSubmit={(e) => { e.preventDefault(); onSubmit() }}>
        {isReset ? (
          <p className="mb-4 text-sm text-danger/90 leading-relaxed whitespace-pre-wrap">
            This will <b>permanently erase ALL vault items</b>. Enter your password and current PIN to confirm.
          </p>
        ) : (
          <p className="mb-4 text-sm text-ink-faint leading-relaxed">
            Choose a 4 or 6 digit PIN. Values are encrypted at rest and you'll enter your PIN each time you add, edit, delete, or use an item.
          </p>
        )}
        <div className="space-y-4">
          {isReset && (
            <>
              <Field label="Current PIN" labelVariant="compact">
                <Input
                  type="password"
                  inputMode="numeric"
                  value={form.oldPin}
                  onChange={(e) => set('oldPin', digitsOnly(e))}
                  placeholder="••••••"
                  autoComplete="current-password"
                  mono
                  className={pinFieldCls}
                />
              </Field>
              <Field label="Your password" labelVariant="compact">
                <Input
                  type="password"
                  value={form.password}
                  onChange={(e) => set('password', e.target.value)}
                  placeholder="dashboard login password"
                  autoComplete="current-password"
                />
              </Field>
            </>
          )}
          <Field label="New PIN" labelVariant="compact">
            <Input
              type="password"
              inputMode="numeric"
              value={form.pin}
              onChange={(e) => set('pin', digitsOnly(e))}
              placeholder="••••••"
              autoFocus={!isReset}
              autoComplete="new-password"
              mono
              className={pinFieldCls}
            />
          </Field>
          <Field label="Confirm PIN" labelVariant="compact">
            <Input
              type="password"
              inputMode="numeric"
              value={form.confirm}
              onChange={(e) => set('confirm', digitsOnly(e))}
              placeholder="••••••"
              autoComplete="new-password"
              mono
              className={pinFieldCls}
            />
          </Field>
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-3 pt-4">
          <Button variant="ghost" size="lg" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant={isReset ? 'danger' : 'primary'} size="lg" disabled={busy}>
            {busy ? (isReset ? 'Resetting…' : 'Setting…') : (isReset ? 'Erase & reset' : 'Set PIN')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function PinPromptModal({ action, item, pin, setPin, error, busy, digitsOnly, onCancel, onSubmit }) {
  const verbs = { save: 'save your changes', delete: `delete '${item?.name}'` }
  return (
    <Modal
      open
      onClose={onCancel}
      title="Vault is locked"
      headerExtra={
        <span className="w-9 h-9 rounded-pill bg-warning-soft border border-warning-line/40 flex items-center justify-center shrink-0">
          <LockIcon className="w-5 h-5 text-warning" />
        </span>
      }
    >
      {/* The submit button stays INSIDE the form, so Enter-to-submit works. */}
      <form onSubmit={(e) => { e.preventDefault(); onSubmit() }}>
        <p className="mb-4 text-sm text-ink-faint leading-relaxed">
          Enter your PIN to {verbs[action] || 'use the vault'}.
        </p>
        <Input
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(e) => { setPin(digitsOnly(e)); }}
          placeholder="••••••"
          autoFocus
          autoComplete="current-password"
          mono
          className={pinFieldCls}
        />
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        <div className="flex items-center justify-end gap-3 pt-4">
          <Button variant="ghost" size="lg" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="lg" disabled={busy}>
            {busy ? 'Unlocking…' : 'Unlock & continue'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
