import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api } from '../lib/api'
import { statusMeta } from '../lib/status'

export default function Onboard() {
  const { agentId } = useParams()
  const [agent, setAgent] = useState(null)
  const [botToken, setBotToken] = useState('')
  const [userId, setUserId] = useState('')
  const [apiKeyProvider, setApiKeyProvider] = useState('')
  const [apiKeyValue, setApiKeyValue] = useState('')
  const [output, setOutput] = useState('Output will appear here...')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api(`/api/agents/${agentId}`).then((d) => {
      if (d) setAgent(d)
    }).catch(() => {})
  }, [agentId])

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    setOutput('Running onboard...')

    try {
      await api(`/api/agents/${agentId}/onboard`, {
        method: 'POST',
        body: {
          bot_token: botToken,
          user_id: userId,
          api_key_provider: apiKeyProvider,
          api_key_value: apiKeyValue,
        },
        timeout: 60000,
      })
      setOutput('Onboard complete! The agent should now be configured with Telegram and API keys.')
    } catch (err) {
      setError(err.error || err.message || 'Onboard failed')
      setOutput('Error: ' + (err.error || err.message))
    } finally {
      setLoading(false)
    }
  }

  if (!agent) return <div className="text-slate-500 text-sm py-8">Loading...</div>

  const st = statusMeta(agent.status)

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link to={`/agents/${agent.name}/commands`} className="text-slate-400 hover:text-white">&larr; {agent.name}</Link>
        <h1 className="text-2xl font-bold">Onboard Bot</h1>
      </div>

      <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-5 space-y-4 mb-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-300">Status</span>
          <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium ${agent.status === 'running' ? 'bg-emerald-900/50 text-emerald-400 border border-emerald-800' : 'bg-slate-800 text-slate-400 border border-slate-700'}`}>
            {agent.status}
          </span>
        </div>
        <div className="text-sm text-slate-300">
          Agent: <span className="font-semibold">{agent.agent_type}</span>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Telegram Bot</h2>

          <div>
            <label className="block text-sm text-slate-300 mb-1">Bot Token</label>
            <input type="text" value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="123456:ABCdef..."
                   className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500 placeholder-slate-500" />
          </div>

          <div>
            <label className="block text-sm text-slate-300 mb-1">Allow User ID</label>
            <input type="text" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="532156945"
                   className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500 placeholder-slate-500" />
          </div>
        </div>

        <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Provider API Key</h2>

          <div>
            <label className="block text-sm text-slate-300 mb-1">API Key</label>
            <div className="flex gap-2">
              <select value={apiKeyProvider} onChange={(e) => setApiKeyProvider(e.target.value)} className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500">
                <option value="">Provider</option>
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
                <option value="ollama-cloud">Ollama Cloud</option>
                <option value="anthropic">Anthropic</option>
              </select>
              <input type="text" value={apiKeyValue} onChange={(e) => setApiKeyValue(e.target.value)} placeholder="sk-..."
                     className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500 placeholder-slate-500 font-mono" />
            </div>
          </div>
        </div>

        <button type="submit" disabled={loading}
                className="w-full bg-purple-600 hover:bg-purple-500 text-white font-semibold py-3 rounded-xl transition-colors disabled:opacity-50">
          {loading ? 'Running...' : 'Run Onboard'}
        </button>
      </form>

      {error && <div className="mt-4 bg-red-900/50 border border-red-800 rounded-xl p-4 text-sm text-red-400">{error}</div>}

      <div className="mt-4 bg-slate-900 border border-slate-700 rounded-xl p-4 text-xs font-mono text-slate-300 overflow-auto max-h-96 whitespace-pre-wrap">
        {output}
      </div>
    </div>
  )
}
