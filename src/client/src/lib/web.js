/** The webui and the published web apps run on the same host, so the base is
 *  derived from wherever the dashboard is being viewed from — unless an
 *  override is configured. Set HOST_NAME (and optionally HOST_PROTO) in .env to
 *  pin the base to a fixed host regardless of where the dashboard is loaded. */
let config = null
let configPromise = null

/** Load /api/config once and cache it. Falls back to window.location values. */
export function loadWebConfig() {
  if (!configPromise) {
    configPromise = fetch('/api/config', { credentials: 'same-origin' })
      .then((r) => r.json().catch(() => ({})))
      .then((c) => {
        config = c
        return c
      })
      .catch(() => {
        config = {}
        return config
      })
  }
  return configPromise
}

export function webBase() {
  const host = config?.host
  if (host) {
    const proto = config?.hostProtocol || 'http'
    return `${proto}://${host}`
  }
  return `${window.location.protocol}//${window.location.hostname}`
}

export function webUrlForPort(hostPort, token) {
  if (!hostPort) return ''
  const base = `${webBase()}:${hostPort}`
  return token ? `${base}#token=${encodeURIComponent(token)}` : base
}

/** Direct URL for an agent's published web app, or '' when not published.
 *  Appends the `#token=...` fragment when the console accepts tokenized URLs
 *  (openclaw Control UI) so opening it auto-authenticates. */
export function webUrlForAgent(agent) {
  const w = agent && agent.web
  if (!w || !w.active || !w.hostPort) return ''
  return webUrlForPort(w.hostPort, w.token)
}
