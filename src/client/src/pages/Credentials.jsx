import { useState, useEffect } from 'react'
import { api } from '../lib/api'

function maskKey(key) {
  if (!key || key.length <= 8) return '****'
  return key.slice(0, 4) + '*'.repeat(key.length - 8) + key.slice(-4)
}

function UsedByBadges({ agents }) {
  if (!agents || agents.length === 0) return <span className="text-slate-600">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {agents.map((a) => (
        <span key={a.name}
              className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${a.status === 'running' ? 'bg-cyan-900/50 text-cyan-300 border border-cyan-800' : 'bg-slate-800 text-slate-400 border border-slate-700'}`}>
          {a.name}
        </span>
      ))}
    </div>
  )
}

export default function Credentials() {
  const [tab, setTab] = useState('api-keys')
  const [apiKeys, setApiKeys] = useState({})
  const [botTokens, setBotTokens] = useState({})
  const [userIds, setUserIds] = useState({})
  const [msg, setMsg] = useState('')
  const [akName, setAkName] = useState('')
  const [akProvider, setAkProvider] = useState('')
  const [akKey, setAkKey] = useState('')
  const [btName, setBtName] = useState('')
  const [btToken, setBtToken] = useState('')
  const [uidName, setUidName] = useState('')
  const [uidVal, setUidVal] = useState('')

  function load() {
    api('/api/credentials').then((d) => {
      if (d) {
        setApiKeys(d.api_keys || {})
        setBotTokens(d.bot_tokens || {})
        setUserIds(d.user_ids || {})
      }
    }).catch(() => {})
  }

  useEffect(load, [])
  useEffect(() => {
    const t = location.hash.replace('#creds-', '') || 'api-keys'
    if (['api-keys', 'messaging'].includes(t)) setTab(t)
    const handler = () => {
      const h = location.hash.replace('#creds-', '') || 'api-keys'
      if (['api-keys', 'messaging'].includes(h)) setTab(h)
    }
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])

  function switchTab(t) {
    setTab(t)
    history.replaceState(null, '', '#creds-' + t)
  }

  async function addApiKey(e) {
    e.preventDefault()
    try {
      await api('/api/credentials/api-key', { method: 'POST', body: { name: akName, provider: akProvider, key: akKey } })
      setMsg('API key added')
      setAkName(''); setAkProvider(''); setAkKey('')
      load()
    } catch (err) { setMsg('Error: ' + (err.error || err.message)) }
  }

  async function deleteApiKey(name) {
    if (!confirm(`Delete API key '${name}'?`)) return
    try {
      await api('/api/credentials/delete', { method: 'POST', body: { type: 'api_key', name } })
      setMsg('API key deleted')
      load()
    } catch (err) { setMsg('Error: ' + (err.error || err.message)) }
  }

  async function addBotToken(e) {
    e.preventDefault()
    try {
      await api('/api/credentials/bot-token', { method: 'POST', body: { name: btName, token: btToken } })
      setMsg('Bot token added')
      setBtName(''); setBtToken('')
      load()
    } catch (err) { setMsg('Error: ' + (err.error || err.message)) }
  }

  async function deleteBotToken(name) {
    if (!confirm(`Delete bot token '${name}'?`)) return
    try {
      await api('/api/credentials/delete', { method: 'POST', body: { type: 'bot_token', name } })
      setMsg('Bot token deleted')
      load()
    } catch (err) { setMsg('Error: ' + (err.error || err.message)) }
  }

  async function addUserId(e) {
    e.preventDefault()
    try {
      await api('/api/credentials/user-id', { method: 'POST', body: { name: uidName, uid: uidVal } })
      setMsg('User ID added')
      setUidName(''); setUidVal('')
      load()
    } catch (err) { setMsg('Error: ' + (err.error || err.message)) }
  }

  async function deleteUserId(name) {
    if (!confirm(`Delete user ID '${name}'?`)) return
    try {
      await api('/api/credentials/delete', { method: 'POST', body: { type: 'user_id', name } })
      setMsg('User ID deleted')
      load()
    } catch (err) { setMsg('Error: ' + (err.error || err.message)) }
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Credentials</h1>
      </div>
      {msg && <div className="mb-4 text-xs text-cyan-400">{msg}</div>}

      <div className="flex gap-6 flex-1 min-h-0" id="creds-layout">
        <aside className="w-48 flex-shrink-0" id="creds-sidebar">
          <nav className="space-y-1 sticky top-24">
            <button onClick={() => switchTab('api-keys')}
                    className={`w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg border-l-[3px] transition-all ${tab === 'api-keys' ? 'border-cyan-400 text-cyan-400 bg-cyan-950/40' : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <span className="flex items-center gap-2.5">
                <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>
                API Keys
              </span>
            </button>
            <button onClick={() => switchTab('messaging')}
                    className={`w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg border-l-[3px] transition-all ${tab === 'messaging' ? 'border-cyan-400 text-cyan-400 bg-cyan-950/40' : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <span className="flex items-center gap-2.5">
                <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                Messaging
              </span>
            </button>
          </nav>
        </aside>

        <div className="flex-1 min-w-0">
          {tab === 'api-keys' && (
            <div className="bg-slate-800/50 border border-slate-700/60 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-700/60">
                <div className="flex items-center gap-3">
                  <h2 className="text-base font-semibold text-slate-100">API Keys</h2>
                  <span className="text-[11px] text-slate-500 bg-slate-800 px-2 py-0.5 rounded-full">agent model authentication</span>
                </div>
              </div>
              <div className="p-5">
                <form onSubmit={addApiKey} className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr_auto] gap-3 mb-5 items-end">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">Name</label>
                    <input type="text" value={akName} onChange={(e) => setAkName(e.target.value)} placeholder="e.g. my-key" required
                           className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">Provider</label>
                    <select value={akProvider} onChange={(e) => setAkProvider(e.target.value)} required
                            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500">
                      <option value="">Select</option>
                      <option value="openai">OpenAI</option>
                      <option value="openrouter">OpenRouter</option>
                      <option value="ollama-cloud">Ollama Cloud</option>
                      <option value="anthropic">Anthropic</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">Key</label>
                    <input type="text" value={akKey} onChange={(e) => setAkKey(e.target.value)} placeholder="sk-..." required
                           className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500" />
                  </div>
                  <button type="submit" className="bg-cyan-700 hover:bg-cyan-600 text-white px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors flex items-center gap-1.5">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
                    Add Key
                  </button>
                </form>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-slate-500 border-b border-slate-700/60">
                      <th className="text-left font-medium py-2.5 px-3 w-[20%]">Name</th>
                      <th className="text-left font-medium py-2.5 px-3 w-[15%]">Provider</th>
                      <th className="text-left font-medium py-2.5 px-3 w-[22%]">Key</th>
                      <th className="text-left font-medium py-2.5 px-3">Used By</th>
                      <th className="text-right font-medium py-2.5 px-3 w-[80px]"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/40">
                    {Object.entries(apiKeys).length === 0 && (
                      <tr><td colSpan={5} className="py-8 text-center text-sm text-slate-600">No API keys configured</td></tr>
                    )}
                    {Object.entries(apiKeys).map(([name, ak]) => (
                      <tr key={name}>
                        <td className="py-2.5 px-3 text-slate-300">{name}</td>
                        <td className="py-2.5 px-3 text-slate-300">{ak.provider}</td>
                        <td className="py-2.5 px-3 text-slate-400 font-mono text-xs">{maskKey(ak.key)}</td>
                        <td className="py-2.5 px-3"><UsedByBadges agents={ak.used_by} /></td>
                        <td className="py-2.5 px-3 text-right">
                          <button onClick={() => deleteApiKey(name)} className="text-xs text-red-400 hover:text-red-300 transition-colors">Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'messaging' && (
            <div className="space-y-6">
              <div className="bg-slate-800/50 border border-slate-700/60 rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-700/60">
                  <div className="flex items-center gap-3">
                    <h2 className="text-base font-semibold text-slate-100">Bot Tokens</h2>
                    <span className="text-[11px] text-slate-500 bg-slate-800 px-2 py-0.5 rounded-full">messaging platform auth</span>
                  </div>
                </div>
                <div className="p-5">
                  <form onSubmit={addBotToken} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 mb-5 items-end">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-500 mb-1">Name</label>
                      <input type="text" value={btName} onChange={(e) => setBtName(e.target.value)} placeholder="e.g. my_bot" required
                             className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500" />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-500 mb-1">Token</label>
                      <input type="text" value={btToken} onChange={(e) => setBtToken(e.target.value)} placeholder="123456:ABCdef..." required
                             className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500" />
                    </div>
                    <button type="submit" className="bg-cyan-700 hover:bg-cyan-600 text-white px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors flex items-center gap-1.5">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
                      Add Token
                    </button>
                  </form>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-slate-500 border-b border-slate-700/60">
                        <th className="text-left font-medium py-2.5 px-3 w-[20%]">Name</th>
                        <th className="text-left font-medium py-2.5 px-3 w-[22%]">Token</th>
                        <th className="text-left font-medium py-2.5 px-3 w-[15%]">Platform</th>
                        <th className="text-left font-medium py-2.5 px-3">Used By</th>
                        <th className="text-right font-medium py-2.5 px-3 w-[80px]"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/40">
                      {Object.entries(botTokens).length === 0 && (
                        <tr><td colSpan={5} className="py-8 text-center text-sm text-slate-600">No bot tokens configured</td></tr>
                      )}
                      {Object.entries(botTokens).map(([name, val]) => {
                        const tokenStr = typeof val === 'string' ? val : val.token
                        const platform = typeof val === 'string' ? 'telegram' : (val.platform || 'telegram')
                        return (
                          <tr key={name}>
                            <td className="py-2.5 px-3 text-slate-300">{name}</td>
                            <td className="py-2.5 px-3 text-slate-400 font-mono text-xs">{maskKey(tokenStr)}</td>
                            <td className="py-2.5 px-3"><span className="px-2 py-0.5 rounded text-xs bg-slate-800 text-slate-300">{platform}</span></td>
                            <td className="py-2.5 px-3"><UsedByBadges agents={val.used_by} /></td>
                            <td className="py-2.5 px-3 text-right">
                              <button onClick={() => deleteBotToken(name)} className="text-xs text-red-400 hover:text-red-300 transition-colors">Delete</button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="bg-slate-800/50 border border-slate-700/60 rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-700/60">
                  <div className="flex items-center gap-3">
                    <h2 className="text-base font-semibold text-slate-100">Allowed User IDs</h2>
                    <span className="text-[11px] text-slate-500 bg-slate-800 px-2 py-0.5 rounded-full">allowlisted DM access</span>
                  </div>
                </div>
                <div className="p-5">
                  <form onSubmit={addUserId} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 mb-5 items-end">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-500 mb-1">Name</label>
                      <input type="text" value={uidName} onChange={(e) => setUidName(e.target.value)} placeholder="e.g. boniface" required
                             className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500" />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-500 mb-1">User ID</label>
                      <input type="text" value={uidVal} onChange={(e) => setUidVal(e.target.value)} placeholder="Telegram user ID" required
                             className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500" />
                    </div>
                    <button type="submit" className="bg-cyan-700 hover:bg-cyan-600 text-white px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors flex items-center gap-1.5">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
                      Add User
                    </button>
                  </form>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-slate-500 border-b border-slate-700/60">
                        <th className="text-left font-medium py-2.5 px-3 w-[20%]">Name</th>
                        <th className="text-left font-medium py-2.5 px-3 w-[22%]">User ID</th>
                        <th className="text-left font-medium py-2.5 px-3 w-[15%]">Platform</th>
                        <th className="text-left font-medium py-2.5 px-3">Used By</th>
                        <th className="text-right font-medium py-2.5 px-3 w-[80px]"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/40">
                      {Object.entries(userIds).length === 0 && (
                        <tr><td colSpan={5} className="py-8 text-center text-sm text-slate-600">No user IDs configured</td></tr>
                      )}
                      {Object.entries(userIds).map(([name, val]) => {
                        const uidStr = typeof val === 'string' ? val : (val.uid || val.token)
                        const platform = typeof val === 'string' ? 'telegram' : (val.platform || 'telegram')
                        return (
                          <tr key={name}>
                            <td className="py-2.5 px-3 text-slate-300">{name}</td>
                            <td className="py-2.5 px-3 text-slate-400 font-mono text-xs">{uidStr}</td>
                            <td className="py-2.5 px-3"><span className="px-2 py-0.5 rounded text-xs bg-slate-800 text-slate-300">{platform}</span></td>
                            <td className="py-2.5 px-3"><UsedByBadges agents={val.used_by} /></td>
                            <td className="py-2.5 px-3 text-right">
                              <button onClick={() => deleteUserId(name)} className="text-xs text-red-400 hover:text-red-300 transition-colors">Delete</button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
