import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../stores/auth'
import { useKeyboardShortcuts } from '../lib/shortcuts'
import { toggleTheme, getTheme } from '../lib/theme'
import Button from './ui/Button'
import { useAgents } from '../stores/agents'
import { useToast } from '../lib/toast'
import { version as APP_VERSION } from '../../../package.json'

/** One link in the top bar. The current page is marked for the eye (accent
 *  colour) and for a screen reader (aria-current). */
function TopLink({ to, active, children }) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={`shrink-0 px-3 py-1.5 rounded-control text-sm transition-colors hover:bg-panel ${active ? 'text-accent-text font-medium' : 'text-ink-muted hover:text-ink'}`}
    >
      {children}
    </Link>
  )
}

export default function DashboardLayout({ children, fullHeight, fullWidth }) {
  const navigate = useNavigate()
  const logout = useAuth((s) => s.logout)
  const username = useAuth((s) => s.username)
  const role = useAuth((s) => s.role)
  const [theme, setTheme] = useState(getTheme())
  const path = useLocation().pathname
  const isAdmin = role === 'admin'
  const toast = useToast()

  // A failed start / stop / restart is reported wherever the user is: the
  // store records it, this shows it once.
  const actionError = useAgents((s) => s.actionError)
  const clearActionError = useAgents((s) => s.clearActionError)
  useEffect(() => {
    if (!actionError) return
    toast.error(actionError.text, { duration: 10000 })
    clearActionError()
  }, [actionError, clearActionError, toast])

  useKeyboardShortcuts()

  function handleToggleTheme() {
    setTheme(toggleTheme())
  }

  async function handleLogout() {
    try {
      await logout()
      navigate('/login')
    } catch (e) {
      // A network blip used to make Sign out do nothing and say nothing.
      toast.error(e?.error || e?.message || 'Could not sign out. Check the connection and try again.', { duration: 10000 })
    }
  }

  const mainClass = fullHeight
    ? 'flex-1 overflow-hidden flex flex-col'
    : fullWidth
    ? 'flex-1 w-full px-4 sm:px-6 lg:px-8 py-6'
    : 'flex-1'

  return (
    <div className={`bg-canvas text-ink font-sans antialiased ${fullHeight ? 'h-screen flex flex-col overflow-hidden' : 'min-h-screen flex flex-col'}`}>
      <nav className="border-b border-line-faint bg-canvas/80 sticky top-0 z-50 backdrop-blur-lg">
        <div className="max-w-full mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between gap-3 h-14">
            <Link to="/agents" className="flex shrink-0 items-center gap-2.5 text-base font-bold tracking-tight text-accent-text hover:text-accent-text transition-colors">
              <img src="/paddock-logo.svg" alt="Paddock" className="w-6 h-6" />
              Paddock
            </Link>
            {/* The links scroll inside the bar on a narrow screen. Without
                min-w-0 + overflow-x-auto the bar was wider than a phone and the
                whole page scrolled sideways. */}
            <div className="msn-topnav flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&>*]:shrink-0">
              <TopLink to="/agents" active={path === '/agents' || (path.startsWith('/agents/') && !path.startsWith('/agents/create'))}>Agents</TopLink>
              <TopLink to="/mission" active={path.startsWith('/mission')}>Mission</TopLink>
              <TopLink to="/agents/create" active={path.startsWith('/agents/create')}>+ Agent</TopLink>
              {/* Vault and Configs are admin-only on the server; a regular user
                  is not shown a link that can only answer "Admin access required". */}
              {isAdmin && <TopLink to="/vault" active={path.startsWith('/vault')}>Vault</TopLink>}
              <TopLink to="/backups" active={path.startsWith('/backups')}>Backups</TopLink>
              {isAdmin && <TopLink to="/configs" active={path.startsWith('/configs')}>Configs</TopLink>}
              <span className="w-px h-5 bg-raised mx-1.5" />
              <Button
                variant="ghost"
                size="sm"
                icon
                onClick={handleToggleTheme}
                className="text-ink-faint hover:text-accent-text hover:bg-panel"
                title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {theme === 'dark' ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a 4 4 0 1 1 -8 0 4 4 0 018 0z" /></svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A 9 9 0 0 1 8.646 3.646 9.003 9.003 0 0012 21a 9.003 9.003 0 0 0 8.354 -5.646z" /></svg>
                )}
              </Button>
              {username && (
                <Link to="/profile" aria-current={path.startsWith('/profile') ? 'page' : undefined}
                  className={`shrink-0 px-3 py-1.5 rounded-control text-sm transition-colors hover:bg-panel ${path.startsWith('/profile') ? 'text-accent-text font-medium' : 'text-ink-faint hover:text-ink'}`} title="Settings">
                  {username}
                </Link>
              )}
              <Button
                variant="ghost"
                size="sm"
                icon
                onClick={handleLogout}
                className="text-ink-dim hover:text-danger hover:bg-panel"
                title="Sign out"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a 3 3 0 0 1 -3 3H6a 3 3 0 0 1 -3 -3V7a 3 3 0 0 1 3 -3h4a 3 3 0 0 1 3 3v1" /></svg>
              </Button>
              <span className="shrink-0 px-2 text-xs text-ink-faint" title="Paddock version">v{APP_VERSION}</span>
            </div>
          </div>
        </div>
      </nav>

      <main className={mainClass}>
        {children}
      </main>
    </div>
  )
}
