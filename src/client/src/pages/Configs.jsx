import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api'
import { useToast } from '../lib/toast'
import { useConfirm } from '../lib/confirm'

const inputBase = "w-full px-3 py-2 bg-sunken border rounded-lg text-ink text-sm placeholder:text-ink-dim focus:border-accent-line focus:outline-none focus:ring-1 focus:ring-accent-line/20"
const inputCls = inputBase + " border-line"
const inputSecretCls = inputBase + " border-line font-mono"
const cardCls = "border border-line-faint rounded-xl bg-canvas/50 p-5"
const btnAccent = "px-4 py-2 bg-accent hover:bg-accent-hover disabled:bg-accent-soft disabled:cursor-not-allowed text-accent-ink rounded-lg text-sm font-medium transition-colors"
const btnDanger = "px-4 py-2 bg-danger hover:bg-danger-hover disabled:bg-danger-soft disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
const btnGhost = "px-4 py-2 bg-panel hover:bg-raised text-ink rounded-lg text-sm font-medium transition-colors"

const GROUPS = [
  {
    id: 'networking',
    title: 'Networking & Access',
    description: 'Host identity and workspace paths. Changing these requires a full container recreate.',
    impact: 'recreate',
    keys: ['CONTAINER_PREFIX', 'HOST_NAME', 'HOST_PROTO', 'HOST_WORKSPACE_ROOT'],
  },
  {
    id: 'auth',
    title: 'Authentication',
    description: 'Login behavior and session security. Changes take effect after a webui restart.',
    impact: 'restart',
    keys: ['AUTO_LOGIN', 'SESSION_SECRET', 'AUTH_PASSWORD', 'VAULT_KEY'],
  },
  {
    id: 'agents',
    title: 'Agent Defaults',
    description: 'LLM endpoint and model settings passed to agent containers on create.',
    impact: 'agent',
    keys: ['DEFAULT_MODEL_BASE_URL', 'DEFAULT_MODEL_NAME', 'DEFAULT_CONTEXT_LENGTH', 'DEFAULT_ALLOW_FROM'],
  },
  {
    id: 'guards',
    title: 'Permissions & Guards',
    description: 'File ownership and workspace mount safety guards. Changes take effect after a webui restart.',
    impact: 'restart',
    keys: ['PUID', 'PGID', 'DOCKER_GID', 'GUARD_PROJECT_ROOT', 'GUARD_INSTANCES_PARENT', 'GUARD_AGENT_DATA'],
  },
  {
    id: 'system',
    title: 'System',
    description: 'Read-only system settings. Timezone is set in docker-compose.yml.',
    impact: 'none',
    keys: ['TZ'],
  },
]

const LABELS = {
  CONTAINER_PREFIX: { label: 'Container Prefix', hint: 'Prefix for all PAD container names (e.g. "pad" → pad-myagent)' },
  HOST_NAME: { label: 'Host IP / Hostname', hint: 'Address agents and services use to reach this host' },
  HOST_PROTO: { label: 'Protocol', hint: 'HTTP or HTTPS for agent-facing URLs', type: 'select', options: ['http', 'https'] },
  HOST_WORKSPACE_ROOT: { label: 'Host Workspace Root', hint: 'Absolute host path to the project root (bind-mount source)' },
  AUTO_LOGIN: { label: 'Auto Login', hint: 'Skip the login screen — anyone with network access can use the UI', type: 'toggle' },
  SESSION_SECRET: { label: 'Session Secret', hint: 'Signing key for session cookies — regenerate if compromised', type: 'secret' },
  AUTH_PASSWORD: { label: 'Auth Password', hint: 'Basic-auth password (empty = disabled)', type: 'secret' },
  VAULT_KEY: { label: 'Vault Encryption Key', hint: 'AES-256 key for the vault — changing it makes all existing entries unreadable', type: 'locked' },
  DEFAULT_MODEL_BASE_URL: { label: 'Model API URL', hint: 'OpenAI-compatible endpoint for agent LLM calls', type: 'url' },
  DEFAULT_MODEL_NAME: { label: 'Model Name', hint: 'Model identifier sent to the LLM API' },
  DEFAULT_CONTEXT_LENGTH: { label: 'Context Length', hint: 'Max token budget for agent conversations', type: 'number' },
  DEFAULT_ALLOW_FROM: { label: 'Telegram Allow List', hint: 'Comma-separated Telegram user IDs allowed to message agents' },
  PUID: { label: 'Host UID', hint: 'User ID for file ownership on bind mounts', type: 'number' },
  PGID: { label: 'Host GID', hint: 'Group ID for file ownership on bind mounts', type: 'number' },
  DOCKER_GID: { label: 'Docker GID', hint: 'Host docker group ID for socket access inside agents', type: 'number' },
  GUARD_PROJECT_ROOT: { label: 'Guard: Project Root', hint: 'Block agents from mounting the project root as workspace', type: 'toggle' },
  GUARD_INSTANCES_PARENT: { label: 'Guard: Instances Parent', hint: 'Block agents from mounting the instances directory', type: 'toggle' },
  GUARD_AGENT_DATA: { label: 'Guard: Agent Data', hint: 'Block agents from mounting other agents\' data directories', type: 'toggle' },
  TZ: { label: 'Timezone', hint: 'Container timezone — set via docker-compose.yml, not .env', type: 'readonly' },
}

const SECRET_REVEAL_MAP = {}

function VarInput({ varDef, value, onChange, disabled }) {
  const meta = LABELS[varDef.key] || {}
  const inputType = meta.type || varDef.impact

  if (varDef.isLocked) {
    return (
      <div className="relative">
        <input type="password" value="••••••••" disabled className={inputSecretCls + " opacity-60 cursor-not-allowed pr-10"} />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-dim" title="This value is locked to prevent vault breakage">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
        </span>
      </div>
    )
  }

  if (varDef.isReadonly) {
    return <input type="text" value={value} disabled className={inputCls + " opacity-60 cursor-not-allowed"} />
  }

  if (inputType === 'toggle') {
    const on = value === '1' || value === 'true'
    return (
      <button
        type="button"
        onClick={() => onChange(on ? '0' : '1')}
        disabled={disabled}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-accent-line/30 ${on ? 'bg-accent' : 'bg-raised'}`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
    )
  }

  if (inputType === 'select') {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={inputCls}>
        {meta.options?.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    )
  }

  if (inputType === 'number') {
    return (
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={inputCls}
      />
    )
  }

  if (inputType === 'url') {
    return (
      <input
        type="url"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="http://..."
        className={inputCls + " font-mono text-xs"}
      />
    )
  }

  if (inputType === 'secret') {
    const revealed = SECRET_REVEAL_MAP[varDef.key]
    return (
      <div className="relative">
        <input
          type={revealed ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={inputSecretCls + " pr-10"}
        />
        <button
          type="button"
          onClick={() => { SECRET_REVEAL_MAP[varDef.key] = !SECRET_REVEAL_MAP[varDef.key]; onChange(value) }}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-dim hover:text-ink transition-colors"
          title={revealed ? 'Hide value' : 'Reveal value'}
        >
          {revealed ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" /></svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
          )}
        </button>
      </div>
    )
  }

  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={inputCls}
    />
  )
}

function GroupSection({ group, vars, originalVars, onChange, saving }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [acting, setActing] = useState(false)

  const groupVars = vars.filter((v) => group.keys.includes(v.key))
  const dirtyVars = groupVars.filter((v) => {
    const orig = originalVars.find((o) => o.key === v.key)
    return orig && v.value !== orig.value
  })
  const isDirty = dirtyVars.length > 0
  const hasLocked = groupVars.some((v) => v.isLocked)
  const impact = group.impact

  const actionLabel = impact === 'recreate'
    ? 'Recreate Container'
    : impact === 'restart'
    ? 'Restart Webui'
    : impact === 'agent'
    ? 'Apply Changes'
    : null

  const actionBtnCls = impact === 'recreate' ? btnDanger : btnAccent

  async function handleAction() {
    if (!isDirty && impact !== 'none') return

    const changes = {}
    for (const v of dirtyVars) {
      if (v.isLocked || v.isReadonly) continue
      changes[v.key] = v.value
    }
    if (Object.keys(changes).length === 0) return

    const actionVerb = impact === 'recreate'
      ? 'This will force-recreate the paddock container. The UI will be briefly unavailable.'
      : impact === 'restart'
      ? 'This will restart the webui container. The UI will reconnect automatically.'
      : 'This will save the changes. Agent defaults apply on next agent create.';

    const ok = await confirm({
      title: actionLabel,
      message: actionVerb,
      danger: impact === 'recreate',
      confirmText: actionLabel,
    })
    if (!ok) return

    setActing(true)
    try {
      await api('/api/env', { method: 'POST', body: { vars: changes } })

      if (impact === 'recreate') {
        await api('/api/env/recreate', { method: 'POST' })
        toast.success('Config saved — container recreating. Reconnect in a few seconds…')
      } else if (impact === 'restart') {
        await api('/api/env/restart', { method: 'POST' })
        toast.success('Config saved — webui restarting. Reconnect in a few seconds…')
      } else {
        toast.success('Config saved')
      }
      onChange()
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to save config')
    } finally {
      setActing(false)
    }
  }

  return (
    <section className={cardCls}>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-sm font-medium text-ink">{group.title}</h3>
          <p className="text-xs text-ink-dim mt-1 max-w-lg">{group.description}</p>
        </div>
        {actionLabel && impact !== 'none' && (
          <button
            onClick={handleAction}
            disabled={!isDirty || acting || saving}
            className={actionBtnCls}
          >
            {acting ? 'Working…' : actionLabel}
          </button>
        )}
      </div>

      <div className="space-y-4">
        {groupVars.map((v) => {
          const meta = LABELS[v.key] || {}
          const orig = originalVars.find((o) => o.key === v.key)
          const isChanged = orig && v.value !== orig.value

          return (
            <div key={v.key} className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4">
              <div className="sm:w-48 flex-shrink-0 pt-2">
                <label className="text-xs font-medium text-ink-faint flex items-center gap-1.5">
                  {meta.label || v.key}
                  {isChanged && <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" title="Unsaved change" />}
                </label>
              </div>
              <div className="flex-1 max-w-md">
                <VarInput varDef={v} value={v.value} onChange={(val) => onChange(v.key, val)} disabled={saving || v.isLocked || v.isReadonly} />
                {(meta.hint || v.description) && (
                  <p className="text-[11px] text-ink-dim mt-1 leading-relaxed">{meta.hint || v.description}</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export default function Configs() {
  const toast = useToast()
  const [vars, setVars] = useState([])
  const [originalVars, setOriginalVars] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const loadVars = useCallback(async () => {
    try {
      const data = await api('/api/env')
      setVars(data.vars)
      setOriginalVars(data.vars.map((v) => ({ ...v })))
    } catch (err) {
      toast.error('Failed to load config: ' + (err.error || err.message))
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { loadVars() }, [loadVars])

  function handleChange(key, value) {
    setVars((prev) => prev.map((v) => v.key === key ? { ...v, value } : v))
  }

  function handleReset() {
    setVars(originalVars.map((v) => ({ ...v })))
  }

  const anyDirty = vars.some((v, i) => originalVars[i] && v.value !== originalVars[i].value)

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-bold text-ink">Environment Config</h1>
          <p className="text-sm text-ink-faint mt-1">Manage the Paddock's <code className="text-xs bg-sunken px-1.5 py-0.5 rounded font-mono">.env</code> variables</p>
        </div>
        {anyDirty && (
          <button onClick={handleReset} className={btnGhost}>Reset</button>
        )}
      </div>

      {loading ? (
        <div className="text-sm text-ink-dim py-12 text-center">Loading…</div>
      ) : (
        <div className="space-y-5">
          {GROUPS.map((group) => (
            <GroupSection
              key={group.id}
              group={group}
              vars={vars}
              originalVars={originalVars}
              onChange={handleChange}
              saving={saving}
            />
          ))}
        </div>
      )}
    </div>
  )
}
