import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../stores/auth'
import { useKeyboardShortcuts } from '../lib/shortcuts'
import { toggleTheme, getTheme } from '../lib/theme'
import Button from './ui/Button'

export default function DashboardLayout({ children, fullHeight, fullWidth }) {
  const navigate = useNavigate()
  const logout = useAuth((s) => s.logout)
  const username = useAuth((s) => s.username)
  const role = useAuth((s) => s.role)
  const [theme, setTheme] = useState(getTheme())

  useKeyboardShortcuts()

  function handleToggleTheme() {
    setTheme(toggleTheme())
  }

  async function handleLogout() {
    await logout()
    navigate('/login')
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
          <div className="flex items-center justify-between h-14">
            <Link to="/agents" className="flex items-center gap-2.5 text-base font-bold tracking-tight text-accent-text hover:text-accent-text transition-colors">
              <img src="/paddock-logo.svg" alt="Paddock" className="w-6 h-6" />
              Paddock
            </Link>
            <div className="flex items-center gap-0.5">
              <Link to="/agents" className="px-3 py-1.5 rounded-control text-sm text-ink-muted hover:text-ink hover:bg-panel transition-colors">Agents</Link>
              <Link to="/mission" className="px-3 py-1.5 rounded-control text-sm text-ink-muted hover:text-ink hover:bg-panel transition-colors">Mission</Link>
              <Link to="/agents/create" className="px-3 py-1.5 rounded-control text-sm text-ink-muted hover:text-ink hover:bg-panel transition-colors">+ Agent</Link>
              <Link to="/vault" className="px-3 py-1.5 rounded-control text-sm text-ink-muted hover:text-ink hover:bg-panel transition-colors">Vault</Link>
              <Link to="/backups" className="px-3 py-1.5 rounded-control text-sm text-ink-muted hover:text-ink hover:bg-panel transition-colors">Backups</Link>
              <Link to="/configs" className="px-3 py-1.5 rounded-control text-sm text-ink-muted hover:text-ink hover:bg-panel transition-colors">Configs</Link>
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
                <Link to="/profile" className="px-3 py-1.5 rounded-control text-sm text-ink-faint hover:text-ink hover:bg-panel transition-colors" title="Settings">
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
