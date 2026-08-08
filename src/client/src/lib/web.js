/** The webui and the published web apps run on the same host, so the base is
 *  derived from wherever the dashboard is being viewed from. */
export function webBase() {
  return `${window.location.protocol}//${window.location.hostname}`
}

export function webUrlForPort(hostPort) {
  return hostPort ? `${webBase()}:${hostPort}` : ''
}

/** Direct URL for an agent's published web app, or '' when not published. */
export function webUrlForAgent(agent) {
  const w = agent && agent.web
  if (!w || !w.active || !w.hostPort) return ''
  return webUrlForPort(w.hostPort)
}
