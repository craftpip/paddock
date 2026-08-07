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

  if (!agent) return <div className="text-ink-dim text-sm py-8">Loading...</div>

  const st = statusMeta(agent.status)

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link to={`/agents/${agent.name}/commands`} className="text-ink-faint hover:text-ink">&larr; {agent.name}</Link>
        <h1 className="text-2xl font-bold">Onboard Bot</h1>
      </div>

      <div className="bg-panel/60 border border-line rounded-xl p-5 space-y-4 mb-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-ink-muted">Status</span>
          <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium ${agent.status === 'running' ? 'bg-success-soft text-success border border-success-line' : 'bg-panel text-ink-faint border border-line'}`}>
            {agent.status}
          </span>
        </div>
        <div className="text-sm text-ink-muted">
          Agent: <span className="font-semibold">{agent.agent_type}</span>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-panel/60 border border-line rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-ink-faint uppercase tracking-wider">Telegram Bot</h2>

          <div>
            <label className="block text-sm text-ink-muted mb-1">Bot Token</label>
            <input type="text" value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="123456:ABCdef..."
                   className="w-full bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line placeholder-ink-dim" />
          </div>

          <div>
            <label className="block text-sm text-ink-muted mb-1">Allow User ID</label>
            <input type="text" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="532156945"
                   className="w-full bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line placeholder-ink-dim" />
          </div>
        </div>

        <div className="bg-panel/60 border border-line rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-ink-faint uppercase tracking-wider">Provider API Key</h2>

          <div>
            <label className="block text-sm text-ink-muted mb-1">API Key</label>
            <div className="flex gap-2">
              <select value={apiKeyProvider} onChange={(e) => setApiKeyProvider(e.target.value)} className="bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line">
                <option value="">Provider</option>
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
                <option value="ollama-cloud">Ollama Cloud</option>
                <option value="anthropic">Anthropic</option>
              </select>
              <input type="text" value={apiKeyValue} onChange={(e) => setApiKeyValue(e.target.value)} placeholder="sk-..."
                     className="flex-1 bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line placeholder-ink-dim font-mono" />
            </div>
          </div>
        </div>

        <button type="submit" disabled={loading}
                className="w-full bg-brand hover:bg-brand text-brand-ink font-semibold py-3 rounded-xl transition-colors disabled:opacity-50">
          {loading ? 'Running...' : 'Run Onboard'}
        </button>
      </form>

      {error && <div className="mt-4 bg-danger-soft border border-danger-line rounded-xl p-4 text-sm text-danger">{error}</div>}

      <div className="mt-4 bg-sunken border border-line rounded-xl p-4 text-xs font-mono text-ink-muted overflow-auto max-h-96 whitespace-pre-wrap">
        {output}
      </div>
    </div>
  )
}
