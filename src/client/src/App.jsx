import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
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
import Onboard from './pages/Onboard'
import Profile from './pages/Profile'
import DashboardLayout from './components/DashboardLayout'

function RequireAuth({ children }) {
  const authenticated = useAuth((s) => s.authenticated)
  const loading = useAuth((s) => s.loading)

  if (loading) return null
  if (!authenticated) return <Navigate to="/login" replace />
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

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <PromptProvider>
          <AlertProvider>
          <BrowserRouter>
          <AuthGate>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/setup" element={<Setup />} />
              <Route path="/agents" element={<AuthPage><Dashboard /></AuthPage>} />
              <Route path="/agents/create" element={<AuthPage><CreateAgent /></AuthPage>} />
              <Route path="/agents/create/:name" element={<AuthPage><CreateAgent /></AuthPage>} />
              <Route path="/agents/:agentId/onboard" element={<AuthPage><Onboard /></AuthPage>} />
              <Route path="/agents/:agentId/:tab" element={<AuthPage fullHeight><AgentDetail /></AuthPage>} />
              <Route path="/agents/:agentId" element={<AuthPage fullHeight><AgentDetail /></AuthPage>} />
              <Route path="/vault" element={<AuthPage><Vault /></AuthPage>} />
              <Route path="/backups" element={<AuthPage><GlobalBackups /></AuthPage>} />
              <Route path="/profile" element={<AuthPage><Profile /></AuthPage>} />
              <Route path="/profile/:tab" element={<AuthPage><Profile /></AuthPage>} />
              <Route path="/credentials" element={<Navigate to="/vault" replace />} />
              <Route path="/" element={<Navigate to="/agents" replace />} />
              <Route path="*" element={<Navigate to="/agents" replace />} />
            </Routes>
          </AuthGate>
        </BrowserRouter>
        </AlertProvider>
        </PromptProvider>
      </ConfirmProvider>
    </ToastProvider>
  )
}
