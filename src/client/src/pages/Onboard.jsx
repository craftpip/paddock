import { useDocumentTitle } from '../lib/useDocumentTitle'
import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api } from '../lib/api'
import { statusMeta } from '../lib/status'
import Button from '../components/ui/Button'
import { Input, Select } from '../components/ui/Input'
import Field from '../components/ui/Field'
import Card from '../components/ui/Card'
import Badge from '../components/ui/Badge'
import { TONES } from '../components/ui/tone'
import { cx } from '../lib/cx'

export default function Onboard() {
  useDocumentTitle('Set up agent')
  const { agentId } = useParams()
  const [agent, setAgent] = useState(null)
  const [botToken, setBotToken] = useState('')
  const [userId, setUserId] = useState('')
  const [apiKeyProvider, setApiKeyProvider] = useState('')
  const [apiKeyValue, setApiKeyValue] = useState('')
  const [output, setOutput] = useState('Output will appear here...')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [loadFailed, setLoadFailed] = useState('')

  useEffect(() => {
    api(`/api/agents/${agentId}`).then((d) => {
      if (d) setAgent(d)
    }).catch((e) => setLoadFailed(e?.error || e?.message || 'Could not load this agent'))
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

  if (loadFailed) {
    return (
      <div className="py-8 text-sm">
        <p className="text-danger">{loadFailed}</p>
        <Link to="/agents" className="mt-2 inline-block text-accent-text hover:underline">Back to the fleet</Link>
      </div>
    )
  }
  if (!agent) return <div className="text-ink-dim text-sm py-8">Loading...</div>

  const st = statusMeta(agent.status)

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link to={`/agents/${agent.name}/commands`} className="text-ink-faint hover:text-ink">&larr; {agent.name}</Link>
        <h1 className="text-2xl font-bold">Onboard Bot</h1>
      </div>

      <Card className="p-5 space-y-4 mb-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-ink-muted">Status</span>
          <Badge
            tone={agent.status === 'running' ? 'success' : 'neutral'}
            size="md"
            className={agent.status === 'running' ? 'border border-success-line' : 'border border-line'}
          >
            {agent.status}
          </Badge>
        </div>
        <div className="text-sm text-ink-muted">
          Agent: <span className="font-semibold">{agent.agent_type}</span>
        </div>
      </Card>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Card className="p-5 space-y-4">
          <h2 className="text-sm font-semibold text-ink-faint uppercase tracking-wider">Telegram Bot</h2>

          <Field label="Bot Token" labelVariant="compact">
            <Input type="text" value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="123456:ABCdef..." />
          </Field>

          <Field label="Allow User ID" labelVariant="compact">
            <Input type="text" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="532156945" />
          </Field>
        </Card>

        <Card className="p-5 space-y-4">
          <h2 className="text-sm font-semibold text-ink-faint uppercase tracking-wider">Provider API Key</h2>

          <Field label="API Key" labelVariant="compact">
            <div className="flex gap-2 items-center">
              {/* Select wraps the native control in a `relative block w-full` span,
                  which as a bare flex item would shrink to nothing — w-fit keeps
                  it sized to its widest option, as the bare <select> was. */}
              <div className="w-fit shrink-0">
                <Select value={apiKeyProvider} onChange={(e) => setApiKeyProvider(e.target.value)}>
                  <option value="">Provider</option>
                  <option value="openai">OpenAI</option>
                  <option value="openrouter">OpenRouter</option>
                  <option value="ollama-cloud">Ollama Cloud</option>
                  <option value="anthropic">Anthropic</option>
                </Select>
              </div>
              <Input type="text" value={apiKeyValue} onChange={(e) => setApiKeyValue(e.target.value)} placeholder="sk-..."
                     mono className="flex-1" />
            </div>
          </Field>
        </Card>

        <Button type="submit" variant="primary" size="lg" block disabled={loading}
                className="bg-brand hover:bg-brand text-brand-ink font-semibold">
          {loading ? 'Running...' : 'Run Onboard'}
        </Button>
      </form>

      {error && <div className={cx('mt-4 rounded-card border p-4 text-sm', TONES.danger.panel)}>{error}</div>}

      <Card plain className="mt-4 p-4 text-xs font-mono text-ink-muted overflow-auto max-h-96 whitespace-pre-wrap">
        {output}
      </Card>
    </div>
  )
}
