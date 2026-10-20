// URL values describe views only. No action, draft or credential is serializable.
export const idValue = (v) => typeof v === 'string' && /^[\w.-]{1,160}$/.test(v) ? v : ''
export const pathValue = (v) => typeof v === 'string' && v.length <= 2048 && !/[\x00-\x1f]/.test(v) && !v.split('/').includes('..') ? v : ''
const mission = /^\/mission(?:\/session\/[\w.-]{1,160})?\/?$/
export const popupRegistry = {
  'project-new': { route: mission, args: [] },
  'project-edit': { route: mission, args: [idValue] },
  'runner-new': { route: mission, args: [idValue] },
  'runner-convert': { route: mission, args: [idValue, idValue] },
  'runner-settings': { route: mission, args: [idValue] },
  'queue-add': { route: mission, args: [idValue] },
  'queue-resolve': { route: mission, args: [idValue, idValue] },
  'file': { route: /^\/agents\/(?!create\/)[^/]+\/workspace\/?$/, args: [pathValue] },
  'file-move': { route: /^\/agents\/(?!create\/)[^/]+\/workspace\/?$/, args: [pathValue] },
  'container-info': { route: /^\/agents\/(?!create\/)[^/]+\/settings\/?$/, args: [idValue] },
  'health-info': { route: /^\/agents\/(?!create\/)[^/]+\/settings\/?$/, args: [idValue] },
  'vault-edit': { route: /^\/vault\/?$/, args: [idValue] },
  'vault-add': { route: /^\/vault\/?$/, args: [] },
  'vault-pin': { route: /^\/vault\/?$/, args: [(v) => ['set', 'reset'].includes(v) ? v : ''] },
  'user-new': { route: /^\/profile(?:\/users)?\/?$/, args: [] },
  'user-password': { route: /^\/profile(?:\/users)?\/?$/, args: [idValue] },
}
export const PROMPT_KEYS = ['start', 'resume', 'continue', 'recovery', 'pause']
export const CALLBACK_KEYS = ['init', 'plan_started', 'plan_completed', 'usage_exhausted', 'destroy']
export const SECTIONS = ['settings', 'prompts', 'callbacks']

export function popupValue(type, ...args) {
  const rule = popupRegistry[type]
  if (!rule || args.length !== rule.args.length || args.some((v, i) => !rule.args[i](String(v)))) throw new Error('Invalid popup descriptor')
  return [type, ...args.map((v) => encodeURIComponent(String(v)))].join(':')
}

export function parsePopups(search, pathname) {
  const params = new URLSearchParams(search)
  const stack = []
  for (const raw of params.getAll('popup').slice(0, 3)) {
    let parts
    try { parts = raw.split(':').map(decodeURIComponent) } catch { break }
    const [type, ...args] = parts
    const rule = popupRegistry[type]
    if (!rule || !rule.route.test(pathname) || args.length !== rule.args.length || args.some((v, i) => !rule.args[i](v))) break
    // Only a move dialog nested on its file has reconstructible parent context.
    if (stack.length && !(type === 'file-move' && stack.at(-1).type === 'file' && args[0] === stack.at(-1).args[0])) break
    if (['container-info', 'health-info'].includes(type)) {
      let owner
      try { owner = decodeURIComponent(pathname.split('/')[2]) } catch { break }
      if (args[0] !== owner) break
    }
    stack.push({ type, args, value: raw })
  }
  return stack
}

export function patchSearch(search, patch) {
  const params = new URLSearchParams(search)
  let changed = false
  for (const [key, value] of Object.entries(patch)) {
    const values = (Array.isArray(value) ? value : [value]).filter((v) => v !== null && v !== undefined && v !== '').map(String)
    const before = params.getAll(key)
    if (before.length === values.length && before.every((v, i) => v === values[i])) continue
    changed = true
    params.delete(key)
    for (const v of values) params.append(key, v)
  }
  if (!changed) return search
  const text = params.toString()
  return text ? `?${text}` : ''
}

export function missionView(search) {
  const p = new URLSearchParams(search)
  const project = p.get('view') === 'all' ? '' : idValue(p.get('project'))
  const session = idValue(p.get('session'))
  const conversation = session ? '' : idValue(p.get('conversation'))
  return { project, session, conversation, terminalProject: conversation ? idValue(p.get('terminalProject')) : '', subfolders: p.get('subfolders') === '1' }
}

export function canonicalMissionSearch(search) {
  const p = new URLSearchParams(search)
  const view = missionView(search)
  const patch = {}
  for (const key of ['project', 'session', 'conversation', 'terminalProject']) if (p.has(key)) patch[key] = view[key] || null
  if (p.has('view')) patch.view = view.project ? 'project' : 'all'
  if (p.has('subfolders')) patch.subfolders = view.subfolders ? '1' : null
  if (p.has('queue')) patch.queue = ['closed', 'open'].includes(p.get('queue')) ? p.get('queue') : null
  if (p.has('runnerTab')) patch.runnerTab = p.get('runnerTab') === 'history' ? 'history' : null
  const popup = parsePopups(search, '/mission').at(-1)
  const setup = ['runner-settings', 'runner-new', 'runner-convert'].includes(popup?.type)
  const section = setup && SECTIONS.includes(p.get('section')) ? p.get('section') : null
  if (p.has('section')) patch.section = section
  if (p.has('prompt')) patch.prompt = section === 'prompts' && PROMPT_KEYS.includes(p.get('prompt')) ? p.get('prompt') : null
  if (p.has('event')) patch.event = section === 'callbacks' && CALLBACK_KEYS.includes(p.get('event')) ? p.get('event') : null
  for (const [key, value] of Object.entries(patch)) {
    const raw = p.getAll(key)
    if (raw.length === 1 && raw[0] === value) delete patch[key]
  }
  return Object.keys(patch).length ? patchSearch(search, patch) : search
}

export function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x1f]/.test(value)) return '/agents'
  const url = new URL(value, 'https://paddock.invalid')
  if (url.origin !== 'https://paddock.invalid' || /^\/(login|setup)(\/|$)/.test(url.pathname)) return '/agents'
  // Only known navigable routes; never an API or executable URL.
  return /^\/(agents|mission|vault|backups|configs|profile)(\/|$)/.test(url.pathname) ? url.pathname + url.search + url.hash : '/agents'
}
