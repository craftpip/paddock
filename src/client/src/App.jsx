import { useEffect } from 'react'
import { createBrowserRouter, createRoutesFromElements, RouterProvider, Outlet, Route, Navigate, useLocation } from 'react-router-dom'
import { NavigationProvider } from './lib/navigation'
import { safeReturnTo } from './lib/url-state'
import { useAuth } from './stores/auth'
import { ToastProvider } from './lib/toast'
import { ConfirmProvider } from './lib/confirm'
import { PromptProvider } from './lib/prompt'
import { AlertProvider } from './lib/alert'
import Login from './pages/Login'
import Setup from './pages/Setup'
import Dashboard from './pages/Dashboard'
import AgentDetail from './pages/AgentDetail'
import CreateAgent from './pages/CreateAgent'
import Vault from './pages/Vault'
import GlobalBackups from './pages/GlobalBackups'
import Configs from './pages/Configs'
import Mission from './pages/Mission'
import MissionSessionPopout from './pages/MissionSessionPopout'
import Onboard from './pages/Onboard'
import Profile from './pages/Profile'
import DashboardLayout from './components/DashboardLayout'

function RequireAuth({ children }) {
  const authenticated = useAuth((s) => s.authenticated)
  const loading = useAuth((s) => s.loading)
  const location = useLocation()

  if (loading) return null
  if (!authenticated) return <Navigate to={`/login?returnTo=${encodeURIComponent(safeReturnTo(location.pathname + location.search + location.hash))}`} replace />
  return children
}

// A signed-in user has no business on /login or /setup: with AUTO_LOGIN on, the
// login form there is a dead end that reads as "you were signed out".
function GuestOnly({ children }) {
  const authenticated = useAuth((s) => s.authenticated)
  const loading = useAuth((s) => s.loading)
  const location = useLocation()

  if (loading) return null
  if (authenticated) return <Navigate to={safeReturnTo(new URLSearchParams(location.search).get("returnTo"))} replace />
  return children
}

function AuthGate({ children }) {
  const checkSession = useAuth((s) => s.checkSession)
  const loading = useAuth((s) => s.loading)

  useEffect(() => {
    checkSession()
  }, [checkSession])

  if (loading) return null
  return children
}

function AuthPage({ children, ...layoutProps }) {
  return (
    <RequireAuth>
      <DashboardLayout {...layoutProps}>{children}</DashboardLayout>
    </RequireAuth>
  )
}

const router = createBrowserRouter(createRoutesFromElements(
  <Route element={<AuthGate><NavigationProvider><Outlet /></NavigationProvider></AuthGate>}>
    <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
    <Route path="/setup" element={<GuestOnly><Setup /></GuestOnly>} />
    <Route path="/agents" element={<AuthPage><Dashboard /></AuthPage>} />
    <Route path="/agents/create" element={<AuthPage><CreateAgent /></AuthPage>} />
    <Route path="/agents/create/:name" element={<AuthPage><CreateAgent /></AuthPage>} />
    <Route path="/agents/:agentId/onboard" element={<AuthPage><Onboard /></AuthPage>} />
    <Route path="/agents/:agentId/:tab" element={<AuthPage fullHeight><AgentDetail /></AuthPage>} />
    <Route path="/agents/:agentId" element={<AuthPage fullHeight><AgentDetail /></AuthPage>} />
    <Route path="/vault" element={<AuthPage><Vault /></AuthPage>} />
    <Route path="/backups" element={<AuthPage><GlobalBackups /></AuthPage>} />
    <Route path="/configs" element={<AuthPage><Configs /></AuthPage>} />
    <Route path="/mission" element={<AuthPage fullHeight><Mission /></AuthPage>} />
    <Route path="/mission/session/:sessionId" element={<RequireAuth><MissionSessionPopout /></RequireAuth>} />
    <Route path="/profile" element={<AuthPage><Profile /></AuthPage>} />
    <Route path="/profile/:tab" element={<AuthPage><Profile /></AuthPage>} />
    <Route path="/credentials" element={<Navigate to="/vault" replace />} />
    <Route path="/" element={<Navigate to="/agents" replace />} />
    <Route path="*" element={<Navigate to="/agents" replace />} />
  </Route>
))

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <PromptProvider>
          <AlertProvider>
           <RouterProvider router={router} />
        </AlertProvider>
        </PromptProvider>
      </ConfirmProvider>
    </ToastProvider>
  )
}
