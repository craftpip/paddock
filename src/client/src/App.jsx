import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './stores/auth'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import AgentDetail from './pages/AgentDetail'
import CreateAgent from './pages/CreateAgent'
import Credentials from './pages/Credentials'
import GlobalBackups from './pages/GlobalBackups'
import Onboard from './pages/Onboard'
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
    <BrowserRouter>
      <AuthGate>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/agents" element={<AuthPage><Dashboard /></AuthPage>} />
          <Route path="/agents/create" element={<AuthPage><CreateAgent /></AuthPage>} />
          <Route path="/agents/:agentId/onboard" element={<AuthPage><Onboard /></AuthPage>} />
          <Route path="/agents/:agentId" element={<AuthPage fullHeight><AgentDetail /></AuthPage>} />
          <Route path="/credentials" element={<AuthPage><Credentials /></AuthPage>} />
          <Route path="/backups" element={<AuthPage><GlobalBackups /></AuthPage>} />
          <Route path="/" element={<Navigate to="/agents" replace />} />
          <Route path="*" element={<Navigate to="/agents" replace />} />
        </Routes>
      </AuthGate>
    </BrowserRouter>
  )
}
