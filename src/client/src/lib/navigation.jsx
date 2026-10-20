import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useBlocker, useLocation, useNavigate } from 'react-router-dom'
import Modal from '../components/ui/Modal'
import Button from '../components/ui/Button'
import { parsePopups, patchSearch, popupValue } from './url-state'

const NavigationContext = createContext(null)
const hrefOf = (l) => l.pathname + l.search + l.hash

export function NavigationProvider({ children }) {
  const location = useLocation()
  const navigate = useNavigate()
  const current = useRef(location)
  current.current = location
  const guards = useRef(new Map())
  const drafts = useRef(new Map())
  const savedNavigation = useRef('')
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    hrefOf(nextLocation) !== savedNavigation.current && [...guards.current.values()].some((g) => g.blocks(currentLocation, nextLocation)))
  useEffect(() => { savedNavigation.current = '' }, [location])
  const patch = useCallback((values, { replace = false, explicitOpen = '', saved = false, expectedPopup } = {}) => {
    const from = current.current
    if (expectedPopup !== undefined && parsePopups(from.search, from.pathname).at(-1)?.value !== expectedPopup) return
    const search = patchSearch(from.search, values)
    if (search === from.search) return
    if (saved) savedNavigation.current = from.pathname + search + from.hash
    const before = parsePopups(from.search, from.pathname).map((p) => p.value)
    const after = parsePopups(search, from.pathname).map((p) => p.value)
    let parents = (from.state?.popupParents || []).map((p) => ({ ...p, distance: p.distance + (replace ? 0 : 1) }))
    if (!replace && after.length === before.length + 1 && before.every((v, i) => after[i] === v)) {
      parents.push({ href: hrefOf(from), distance: 1 })
    } else if (after.join('|') !== before.join('|')) parents = []
    navigate({ pathname: from.pathname, search, hash: from.hash }, { replace, state: { popupParents: parents, navigated: true, explicitOpen } })
  }, [navigate])
  const closePopup = useCallback(({ saved = false, expected } = {}) => {
    const from = current.current
    const stack = parsePopups(from.search, from.pathname)
    if (expected !== undefined && stack.at(-1)?.value !== expected) return
    const parent = from.state?.popupParents?.at(-1)
    const values = { popup: stack.slice(0, -1).map((p) => p.value) }
    if (from.pathname === '/mission') Object.assign(values, { section: null, prompt: null, event: null })
    if (stack.at(-1)?.type === 'queue-add') Object.assign(values, { planQ: null, planAll: null })
    if (!saved && parent && parent.href === from.pathname + patchSearch(from.search, values) + from.hash) {
      navigate(-parent.distance)
    } else {
      patch(values, { replace: true, saved })
    }
  }, [navigate, patch])
  const openPopup = useCallback((type, ...args) => {
    const from = current.current
    const stack = parsePopups(from.search, from.pathname)
    const value = popupValue(type, ...args)
    const values = { popup: type === 'file-move' && stack.at(-1)?.type === 'file' && stack.at(-1)?.args[0] === args[0]
      ? [...stack.map((p) => p.value), value] : value }
    if (from.pathname === '/mission') Object.assign(values, { section: null, prompt: null, event: null })
    patch(values)
  }, [patch])
  const register = useCallback((key, guard) => {
    guards.current.set(key, guard)
    return () => guards.current.delete(key)
  }, [])
  useEffect(() => {
    const raw = new URLSearchParams(location.search).getAll('popup')
    const valid = parsePopups(location.search, location.pathname).map((p) => p.value)
    if (raw.join('|') !== valid.join('|')) patch({ popup: valid }, { replace: true })
  }, [location.pathname, location.search, patch])
  const value = useMemo(() => ({ location, patch, openPopup, closePopup, register, drafts: drafts.current }), [location, patch, openPopup, closePopup, register])
  const discard = () => {
    for (const g of guards.current.values()) if (g.blocks(location, blocker.location)) g.discard?.()
    // The discarded form can remain mounted until the blocked transition lands.
    // Allow that exact destination through instead of blocking it a second time.
    savedNavigation.current = hrefOf(blocker.location)
    blocker.proceed()
  }
  return (
    <NavigationContext.Provider value={value}>
      {children}
      {blocker.state === 'blocked' && (
        <Modal title="Discard changes?" z="z-[100]" onClose={() => blocker.reset()} footer={(
          <><Button onClick={() => blocker.reset()}>Keep editing</Button><Button variant="danger" onClick={discard}>Discard</Button></>
        )}>You have unsaved changes. Discard them before leaving this view?</Modal>
      )}
    </NavigationContext.Provider>
  )
}

export function useNavigation() {
  const context = useContext(NavigationContext)
  if (!context) throw new Error('NavigationProvider is required')
  return context
}

export function useDirtyNavigation(dirty, identity, discard) {
  const { register } = useNavigation()
  const latest = useRef({ dirty, identity, discard })
  latest.current = { dirty, identity, discard }
  useEffect(() => register(latest, {
    blocks: (from, to) => (typeof latest.current.dirty === 'function' ? latest.current.dirty() : latest.current.dirty) && latest.current.identity(from) !== latest.current.identity(to),
    discard: () => latest.current.discard?.(),
  }), [register])
  useEffect(() => {
    const beforeUnload = (event) => {
      if (!(typeof latest.current.dirty === 'function' ? latest.current.dirty() : latest.current.dirty)) return
      event.preventDefault(); event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [])
}

// Memory only, never history.state or localStorage. Navigation between editor
// sections leaves the mounted form alone; Forward can restore its same-tab draft.
export function useDraftState(key, initial) {
  const { drafts } = useNavigation()
  const initialValue = () => drafts.has(key) ? drafts.get(key) : typeof initial === 'function' ? initial() : initial
  const [state, setState] = useState(() => ({ key, value: initialValue() }))
  const value = state.key === key ? state.value : initialValue()
  if (state.key !== key) setState({ key, value })
  const update = useCallback((next) => setState((old) => {
    const prior = old.key === key ? old.value : initialValue()
    const v = typeof next === 'function' ? next(prior) : next
    drafts.set(key, v)
    return { key, value: v }
  }), [drafts, key])
  return [value, update]
}

export function useQueryInput(key, limit = 200) {
  const { location, patch } = useNavigation()
  const raw = (new URLSearchParams(location.search).get(key) || '').slice(0, limit)
  const [text, setText] = useState(raw)
  useEffect(() => { setText(raw) }, [location.key])
  useEffect(() => {
    if (text === raw) return
    const timer = setTimeout(() => patch({ [key]: text.slice(0, limit) }, { replace: true }), 250)
    return () => clearTimeout(timer)
  }, [text, raw, location.key, key, limit, patch])
  return [text, setText]
}

export function popupIdentity(location) {
  return location.pathname + ':' + parsePopups(location.search, location.pathname).map((p) => p.value).join('|')
}

export function usePopup(type) {
  const { location, openPopup, closePopup } = useNavigation()
  const popup = parsePopups(location.search, location.pathname).find((p) => p.type === type)
  return [popup || null, (...args) => openPopup(type, ...args), (options = {}) => closePopup({ ...options, expected: popup?.value })]
}
