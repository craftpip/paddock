let csrfToken = null

export function setCsrfToken(token) {
  csrfToken = token
}

export function getCsrfToken() {
  return csrfToken
}

export async function api(path, options = {}) {
  const { body, method = 'GET', headers = {} } = options

  if (body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }

  if (csrfToken) {
    headers['X-CSRF-Token'] = csrfToken
  }

  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  })

  if (res.status === 401) {
    const isApi = path.startsWith('/api/')
    if (isApi) {
      const data = await res.json().catch(() => ({}))
      throw { status: 401, ...data }
    }
    window.location.href = '/login'
    throw { status: 401 }
  }

  if (res.status === 403 && !options._retried) {
    const data = await res.json().catch(() => ({}))
    if (data.error === 'CSRF token invalid') {
      try {
        const s = await fetch('/api/session', { credentials: 'same-origin' }).then((r) => r.json())
        if (s.csrfToken) setCsrfToken(s.csrfToken)
        return api(path, { ...options, _retried: true })
      } catch {}
    }
    throw { status: 403, ...data }
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw { status: res.status, ...data }
  }

  if (res.status === 204) return null

  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
