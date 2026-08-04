import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../stores/auth'
import { useKeyboardShortcuts } from '../lib/shortcuts'

export default function DashboardLayout({ children, fullHeight, fullWidth }) {
  const navigate = useNavigate()
  const logout = useAuth((s) => s.logout)
  const username = useAuth((s) => s.username)
  const role = useAuth((s) => s.role)

  useKeyboardShortcuts()

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
    <div className={`bg-slate-900 text-slate-100 font-sans antialiased ${fullHeight ? 'h-screen flex flex-col overflow-hidden' : 'min-h-screen flex flex-col'}`}>
      <nav className="border-b border-slate-800 bg-slate-900/80 sticky top-0 z-50 backdrop-blur-lg">
        <div className="max-w-full mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-14">
            <Link to="/agents" className="flex items-center gap-2.5 text-base font-bold tracking-tight text-cyan-400 hover:text-cyan-300 transition-colors">
              <img src="/paddock-logo.svg" alt="Paddock" className="w-6 h-6" />
              Paddock
            </Link>
            <div className="flex items-center gap-0.5">
              <Link to="/agents" className="px-3 py-1.5 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-slate-800 transition-colors">Agents</Link>
              <Link to="/agents/create" className="px-3 py-1.5 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-slate-800 transition-colors">+ Agent</Link>
              <Link to="/vault" className="px-3 py-1.5 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-slate-800 transition-colors">Vault</Link>
              <Link to="/backups" className="px-3 py-1.5 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-slate-800 transition-colors">Backups</Link>
              <span className="w-px h-5 bg-slate-700 mx-1.5" />
              {username && (
                <Link to="/profile" className="px-3 py-1.5 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-slate-800 transition-colors" title="Settings">
                  {username}
                </Link>
              )}
              <button onClick={handleLogout} className="px-3 py-1.5 rounded-lg text-sm text-slate-500 hover:text-red-400 hover:bg-slate-800 transition-colors" title="Sign out">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
              </button>
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
