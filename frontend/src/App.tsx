import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  Bot,
  BrainCircuit,
  CheckCircle2,
  Database,
  FileSearch,
  Gauge,
  KeyRound,
  LayoutDashboard,
  Lock,
  Moon,
  Network,
  PauseCircle,
  Play,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  UserCircle,
  Users,
  Workflow,
  X,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { BrowserRouter, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import './App.css'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000'
const WS_BASE = API_BASE.replace(/^http/, 'ws')

type MetricMap = {
  todaysRequests: number
  runningWorkflows: number
  completedRequests: number
  pendingRequests: number
  pendingApprovals: number
  exceptions: number
  averageSla: string
  averageResolutionTime: string
  approvalRate: number
  agentUtilization: number
  highRiskRequests: number
  slaPerformance: number
}

type RequestItem = {
  id: number
  title: string
  request_type: string
  customer_name: string
  account_number: string
  email: string
  description: string
  department: string
  priority: string
  sla_hours: number
  status: string
  risk_score: number
  confidence: number
  decision: string
  created_at: string
  updated_at: string
}

type Agent = {
  id: number
  name: string
  responsibility: string
  status: string
  currentTask: string
  lastDecision: string
  confidence: number
  executionTimeMs: number
  processedCount: number
}

type Step = {
  id: number
  agentName: string
  status: string
  message: string
  confidence: number
  citations: Array<{ title: string; source: string; category: string; score: number }>
  reasoning: string
  riskFactors: string[]
  createdAt: string
}

type RequestDetails = {
  request: RequestItem
  steps: Step[]
  approvals: Array<{ id: number; status: string; recommendation: string; managerSummary: string; decisionNotes?: string }>
}

type Analytics = {
  categories: Array<{ name: string; value: number }>
  riskDistribution: Array<{ name: string; value: number }>
  slaTrend: Array<{ day: string; met: number; missed: number }>
  recentActivities: Array<{ actor: string; action: string; details: string; createdAt: string }>
}

type WorkflowStage = {
  name: string
  agentName: string
  state: string
  executionTimeMs: number
  confidence: number
  businessRules: string[]
  retrievedSops: Array<{ title: string; source: string; category: string; score: number }>
  reasoning: string
  inputs: Record<string, string | number>
  outputs: { message?: string; riskFactors?: string[] }
}

type WorkflowItem = {
  request: RequestItem
  stages: WorkflowStage[]
}

type User = {
  id: number
  name: string
  email: string
  role: string
  department: string
  is_active: boolean
}

type UserForm = {
  name: string
  email: string
  password: string
  role: string
  department: string
  is_active: boolean
}

type KnowledgeItem = {
  id: number
  title: string
  category: string
  source: string
  content?: string
  score?: number
  createdAt?: string
}

type DocumentInfo = {
  id: number
  requestId?: number
  filename: string
  documentType: string
  summary: string
  entities: Record<string, string>
  extractedText?: string
  uploadedAt: string
}

type AgentRuntime = {
  mode: string
  agents: Array<{ name: string; instructions: string }>
  supports: string[]
}

type NotificationItem = {
  id: number
  requestId?: number
  audience: string
  subject: string
  body: string
  isRead: boolean
  createdAt: string
}

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  citations?: Array<{ title: string; source: string; category: string; score: number }>
}

type AuditLogItem = {
  id: number
  requestId?: number
  actor: string
  action: string
  details: string
  createdAt: string
}

const queryClient = new QueryClient()
const roleOptions = ['Administrator', 'Operations Manager', 'Operations Executive', 'Viewer']
const MANAGER_ROLES = ['Administrator', 'Operations Manager']
const OPERATOR_ROLES = ['Administrator', 'Operations Manager', 'Operations Executive']

function hasRole(user: User | undefined, roles: string[]): boolean {
  return Boolean(user && roles.includes(user.role))
}

function canCreateRequests(user: User | undefined): boolean {
  return hasRole(user, OPERATOR_ROLES)
}

function canManageRequests(user: User | undefined): boolean {
  return hasRole(user, MANAGER_ROLES)
}

function canManageKnowledge(user: User | undefined): boolean {
  return hasRole(user, OPERATOR_ROLES)
}

function canPreviewDocuments(user: User | undefined): boolean {
  return hasRole(user, MANAGER_ROLES)
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('opsflow-token')
  const isForm = options.body instanceof FormData
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (!response.ok) {
    if (response.status === 401) localStorage.removeItem('opsflow-token')
    let message = `API ${response.status}`
    try {
      const body = await response.json()
      message = body.detail ?? message
    } catch {
      message = response.statusText || message
    }
    throw new Error(message)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

async function streamWorkflow(requestId: number, onStep: (step: Step) => void, onStatus: (status: string) => void): Promise<void> {
  const token = localStorage.getItem('opsflow-token')
  if (!token) throw new Error('Missing session token')
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const succeed = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const socket = new WebSocket(`${WS_BASE}/ws/requests/${requestId}/workflow?token=${encodeURIComponent(token)}`)
    socket.onopen = () => {
      onStatus('Connected')
      socket.send(JSON.stringify({ type: 'workflow.start' }))
    }
    socket.onerror = () => {
      onStatus('Failed')
      fail(new Error(`Workflow WebSocket connection failed. Check that the backend is running at ${API_BASE}.`))
    }
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data)
      if (event.type === 'connection.ready') {
        onStatus('Ready')
      }
      if (event.type === 'workflow.status') {
        onStatus(event.status)
      }
      if (event.type === 'error') {
        onStatus('Failed')
        socket.close()
        fail(new Error(event.detail))
      }
      if (event.type === 'agent.step') {
        onStep({
          id: event.stepId,
          agentName: event.agentName,
          status: 'Completed',
          message: event.message,
          confidence: event.confidence,
          citations: event.citations ?? [],
          reasoning: event.reasoning,
          riskFactors: event.riskFactors ?? [],
          createdAt: new Date().toISOString(),
        })
      }
      if (event.type === 'agent.started') {
        onStep({
          id: -Date.now(),
          agentName: event.agentName,
          status: 'Running',
          message: event.message,
          confidence: 0,
          citations: [],
          reasoning: 'Working with request data, uploaded documents, and retrieved policy context.',
          riskFactors: [],
          createdAt: new Date().toISOString(),
        })
      }
      if (event.type === 'workflow.completed') {
        onStatus(event.status)
        socket.close()
        succeed()
      }
    }
    socket.onclose = (event) => {
      if (settled) return
      if (event.code === 1008) {
        onStatus('Failed')
        fail(new Error('Workflow WebSocket authentication failed. Please sign in again.'))
        return
      }
      if (event.code !== 1000) {
        onStatus('Failed')
        fail(new Error(`Workflow WebSocket closed before completion (code ${event.code || 'unknown'}).`))
      }
    }
  })
}

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Root />
      </BrowserRouter>
    </QueryClientProvider>
  )
}

function Root() {
  const [token, setToken] = useState(localStorage.getItem('opsflow-token') ?? '')
  const [dark, setDark] = useState(() => localStorage.getItem('opsflow-theme') !== 'light')

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('opsflow-theme', dark ? 'dark' : 'light')
  }, [dark])

  if (!token) return <Login onLogin={setToken} dark={dark} setDark={setDark} />

  return <Shell onLogout={() => { localStorage.removeItem('opsflow-token'); setToken('') }} dark={dark} setDark={setDark} />
}

function Login({ onLogin, dark, setDark }: { onLogin: (token: string) => void; dark: boolean; setDark: (value: boolean) => void }) {
  const [email, setEmail] = useState('manager@opsflow.ai')
  const [password, setPassword] = useState('')
  const login = useMutation({
    mutationFn: () => api<{ access_token: string }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    onSuccess: (result) => {
      localStorage.setItem('opsflow-token', result.access_token)
      onLogin(result.access_token)
    },
  })

  return (
    <main className="login-screen">
      <button className="icon-button theme-toggle" onClick={() => setDark(!dark)} title="Toggle theme" aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</button>
      <motion.section className="login-panel" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }}>
        <div className="page-title"><div className="brand-mark"><BrainCircuit /></div><h1>OpsFlow AI</h1></div>
        <p className="muted pt-2">Autonomous Enterprise Operations Orchestrator</p>
        <div className="login-grid">
          <label>Email<input value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        </div>
        <button className="primary wide" onClick={() => login.mutate()} disabled={login.isPending}><KeyRound size={18} />{login.isPending ? 'Signing in' : 'Enter Control Tower'}</button>
        {login.error && <ErrorText error={login.error} />}
        <div className="helper-text pt-4">Roles: Administrator, Manager, Executive, Viewer</div>
      </motion.section>
    </main>
  )
}

function Shell({ onLogout, dark, setDark }: { onLogout: () => void; dark: boolean; setDark: (value: boolean) => void }) {
  const user = useQuery({ queryKey: ['me'], queryFn: () => api<User>('/api/me'), retry: false })
  useEffect(() => {
    if (user.error) onLogout()
  }, [user.error, onLogout])

  const nav = [
    { path: '/', Icon: LayoutDashboard, label: 'Dashboard' },
    { path: '/new', Icon: Plus, label: 'New Request', roles: OPERATOR_ROLES },
    { path: '/requests', Icon: Workflow, label: 'Requests' },
    { path: '/knowledge', Icon: Database, label: 'Knowledge Center' },
    { path: '/analytics', Icon: BarChart3, label: 'Analytics' },
    { path: '/audit', Icon: ShieldCheck, label: 'Audit Logs', roles: MANAGER_ROLES },
    { path: '/agents', Icon: BrainCircuit, label: 'AI Workforce', roles: MANAGER_ROLES },
    { path: '/users', Icon: Users, label: 'User Management', roles: ['Administrator'] },
    { path: '/settings', Icon: Settings, label: 'Settings', roles: MANAGER_ROLES },
    { path: '/profile', Icon: UserCircle, label: 'Profile' },
  ].filter((item) => !item.roles || hasRole(user.data, item.roles))

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><BrainCircuit /><div><strong>OpsFlow AI</strong><span>Operations Control Center</span></div></div>
        <nav>
          {nav.map(({ path, Icon, label }) => (
            <NavLink key={path} to={path} end={path === '/'} className={({ isActive }) => cn('nav-link', isActive && 'active')}><Icon size={18} />{label}</NavLink>
          ))}
        </nav>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">Enterprise AI Workforce</p>
            <h2>Autonomous operations with explainable human control</h2>
          </div>
          <div className="top-actions">
            <NotificationCenter />
            <button className="icon-button" onClick={() => setDark(!dark)} title="Toggle theme" aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</button>
            <div className="user-chip"><span>{user.data?.name ?? 'Loading'}</span><small>{user.data?.role ?? 'Resolving session'}</small></div>
            <button className="ghost" onClick={onLogout}><Lock size={16} />Logout</button>
          </div>
        </header>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/new" element={<ProtectedRoute user={user.data} roles={OPERATOR_ROLES}><NewRequest /></ProtectedRoute>} />
          <Route path="/requests" element={<RequestListPage user={user.data} />} />
          <Route path="/requests/:id" element={<RequestDetailsPage user={user.data} />} />
          <Route path="/knowledge" element={<KnowledgeCenter user={user.data} />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/audit" element={<ProtectedRoute user={user.data} roles={MANAGER_ROLES}><AuditLogs /></ProtectedRoute>} />
          <Route path="/agents" element={<ProtectedRoute user={user.data} roles={MANAGER_ROLES}><AgentMonitoring /></ProtectedRoute>} />
          <Route path="/users" element={<ProtectedRoute user={user.data} roles={['Administrator']}><UserManagement /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute user={user.data} roles={MANAGER_ROLES}><SettingsPage /></ProtectedRoute>} />
          <Route path="/profile" element={<ProfilePage user={user.data} onLogout={onLogout} />} />
          <Route path="*" element={<AccessDenied />} />
        </Routes>
        <ChatAssistant />
      </div>
    </div>
  )
}

function ProtectedRoute({ user, roles, children }: { user?: User; roles: string[]; children: ReactNode }) {
  if (!user) return <EmptyState text="Resolving access policy." />
  if (!hasRole(user, roles)) return <AccessDenied />
  return <>{children}</>
}

function AccessDenied() {
  return (
    <Page title="Access Restricted" icon={ShieldCheck}>
      <Panel title="Role-based access control">
        <EmptyState text="Your current role does not include access to this workspace area." />
      </Panel>
    </Page>
  )
}

function NotificationCenter() {
  const [open, setOpen] = useState(false)
  const query = useQueryClient()
  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<NotificationItem[]>('/api/notifications'),
    refetchInterval: 15000,
  })
  const markRead = useMutation({
    mutationFn: (id: number) => api(`/api/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => query.invalidateQueries({ queryKey: ['notifications'] }),
  })
  const unread = notifications.data?.filter((item) => !item.isRead).length ?? 0
  return (
    <div className="notification-wrap">
      <button className="icon-button notification-button" title="Notifications" aria-label="Notifications" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Bell />
        {unread > 0 && <span>{unread}</span>}
      </button>
      {open && (
        <motion.div className="notification-menu" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <header><strong>Notifications</strong><StatusPill status={`${unread} unread`} /></header>
          <div className="notification-list">
            {notifications.isLoading && <SkeletonRows count={3} />}
            {notifications.data?.length ? notifications.data.map((item) => (
              <button key={item.id} className={cn('notification-item', !item.isRead && 'unread')} onClick={() => markRead.mutate(item.id)}>
                <strong>{item.subject}</strong>
                <span>{item.body}</span>
                <small>{new Date(item.createdAt).toLocaleString()}</small>
              </button>
            )) : !notifications.isLoading && <EmptyState text="No notifications yet." />}
          </div>
        </motion.div>
      )}
    </div>
  )
}

function ChatAssistant() {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: 'Good day. I can help with OpsFlow AI, operational requests, approvals, workflow status, and SOP questions from the Knowledge Center.' },
  ])
  const chat = useMutation({
    mutationFn: async (content: string) => api<{ answer: string; citations: ChatMessage['citations'] }>('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        message: content,
        history: messages.slice(-8).map((item) => ({ role: item.role, content: item.content })),
      }),
    }),
    onSuccess: (result) => {
      setMessages((current) => [...current, { role: 'assistant', content: result.answer, citations: result.citations }])
    },
    onError: (error) => {
      setMessages((current) => [...current, { role: 'assistant', content: error instanceof Error ? error.message : 'I could not answer that right now.' }])
    },
  })
  const send = () => {
    const content = message.trim()
    if (!content || chat.isPending) return
    setMessages((current) => [...current, { role: 'user', content }])
    setMessage('')
    chat.mutate(content)
  }
  return (
    <div className="chatbot">
      {open && (
        <motion.section className="chat-panel" initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}>
          <header>
            <div><strong>OpsFlow Assistant</strong><small>Knowledge-aware enterprise helper</small></div>
            <button className="icon-button" style={{fontFamily: 'Sans-serif'}} onClick={() => setOpen(false)} aria-label="Close chat">X</button>
          </header>
          <div className="chat-messages">
            {messages.map((item, index) => (
              <div key={`${item.role}-${index}`} className={cn('chat-message', item.role)}>
                <p>{item.content}</p>
                {item.citations?.length ? (
                  <div className="chat-citations">
                    {item.citations.slice(0, 3).map((citation) => <span key={`${citation.title}-${citation.score}`}>{citation.title}</span>)}
                  </div>
                ) : null}
              </div>
            ))}
            {chat.isPending && <div className="chat-message assistant"><p>Thinking with Knowledge Center context...</p></div>}
          </div>
          <div className="chat-input">
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') send() }}
              placeholder="Ask about workflows, SOPs, policies..."
              aria-label="Chat message"
            />
            <button className="primary" onClick={send} disabled={chat.isPending || !message.trim()} aria-label="Send chat message"><Send size={16} /></button>
          </div>
        </motion.section>
      )}
      <button className="chatbot-button" onClick={() => setOpen(!open)} aria-label="Open OpsFlow chat assistant">
        <Bot />
      </button>
    </div>
  )
}

function Dashboard() {
  const query = useQueryClient()
  const metrics = useQuery({ queryKey: ['metrics'], queryFn: () => api<MetricMap>('/api/dashboard/metrics') })
  const requests = useQuery({ queryKey: ['requests'], queryFn: () => api<RequestItem[]>('/api/requests') })
  const analytics = useQuery({ queryKey: ['analytics'], queryFn: () => api<Analytics>('/api/analytics') })
  const workflows = useQuery({
    queryKey: ['workflows'],
    queryFn: () => api<WorkflowItem[]>('/api/workflows'),
    refetchInterval: 5000,
  })
  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: () => api<Agent[]>('/api/agents'),
    retry: false,
  })
  const [selectedStage, setSelectedStage] = useState<{ workflow: WorkflowItem; stage: WorkflowStage } | null>(null)
  const resetDemo = useMutation({
    mutationFn: () => api('/api/demo/reset', { method: 'POST' }),
    onSuccess: () => {
      query.invalidateQueries()
      window.alert('Demo data reset')
    },
  })
  const cards = [
    ['Today', metrics.data?.todaysRequests, Activity, 'Requests created today'],
    ['Running', metrics.data?.runningWorkflows, Play, 'Active workflows'],
    ['Completed', metrics.data?.completedRequests, CheckCircle2, 'Resolved workflows'],
    ['Pending approvals', metrics.data?.pendingApprovals, ShieldCheck, 'Human decisions needed'],
    ['Exceptions', metrics.data?.exceptions, AlertTriangle, 'Policy or evidence issues'],
    ['Average SLA', metrics.data?.averageSla, Gauge, 'Target resolution window'],
    ['Avg resolution', metrics.data?.averageResolutionTime, Gauge, 'Based on completed requests'],
    ['Agent utilization', `${metrics.data?.agentUtilization ?? 0}%`, BrainCircuit, 'Processed workload share'],
  ] as const

  return (
    <Page title="Enterprise Control Tower" icon={Network}>
      <QueryState queries={[metrics, requests, analytics, workflows]} />
      <section className="control-hero">
        <div>
          <p className="eyebrow">Live Command Surface</p>
          <h2>Operations are streamed, explainable, and approval-aware.</h2>
          <p className="muted">Monitor agent work, policy evidence, risk, SLA health, and human decisions from one control tower.</p>
        </div>
        <div className="hero-indicators">
          <Evidence label="Live Requests" value={`${requests.data?.length ?? 0}`} />
          <Evidence label="Highest Risk" value={`${Math.max(...(requests.data ?? [{ risk_score: 0 }]).map((item) => item.risk_score))}/100`} />
          <button className="primary span-2" onClick={() => resetDemo.mutate()} disabled={resetDemo.isPending}><Sparkles size={18} />Reset Demo Data</button>
        </div>
      </section>
      <section className="metric-grid">
        {metrics.isLoading ? <SkeletonCards count={8} /> : cards.map(([label, value, Icon, helper], index) => <MetricCard key={label} label={label} value={value ?? '-'} Icon={Icon} helper={helper} index={index} />)}
      </section>
      <section className="control-tower-grid">
        <Panel title="Enterprise Workflow Canvas" action={<StatusPill status={workflows.isFetching ? 'Refreshing' : 'Live'} />}>
          <EnterpriseWorkflowBoard workflows={workflows.data ?? []} selected={selectedStage} onSelect={setSelectedStage} />
        </Panel>
        <Panel title="Live Agent Conversation Timeline">
          <AgentConversationTimeline workflows={workflows.data ?? []} />
        </Panel>
      </section>
      {selectedStage && <WorkflowStageDrawer selected={selectedStage} onClose={() => setSelectedStage(null)} />}
      <Panel title="AI Workforce Dashboard">
        {agents.error ? <EmptyState text="AI Workforce Dashboard is available to manager and administrator roles." /> : <AIWorkforceDashboard agents={agents.data ?? []} />}
      </Panel>
      <section className="dashboard-grid">
        <Panel title="Risk Distribution">
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={analytics.data?.riskDistribution ?? []} dataKey="value" nameKey="name" innerRadius={54} outerRadius={92}>
                {['#14b8a6', '#f59e0b', '#ef4444'].map((color) => <Cell key={color} fill={color} />)}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </Panel>
        <Panel title="Request Categories">
          <ResponsiveContainer width="100%" height={300}><BarChart data={analytics.data?.categories ?? []} margin={{ bottom: 46 }}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" angle={-28} textAnchor="end" interval={0} height={58} /><YAxis /><Tooltip /><Bar dataKey="value" fill="#2563eb" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer>
        </Panel>
      </section>
      <section className="dashboard-grid">
        <Panel title="Recent Activities">
          <RecentActivities activities={analytics.data?.recentActivities ?? []} />
        </Panel>
        <Panel title="Request Queue">
          <RequestTable requests={requests.data ?? []} />
        </Panel>
      </section>
    </Page>
  )
}

function RequestListPage({ user }: { user?: User }) {
  const requests = useQuery({ queryKey: ['requests'], queryFn: () => api<RequestItem[]>('/api/requests') })
  return (
    <Page title="Requests" icon={Workflow}>
      <QueryState queries={[requests]} />
      <Panel title="Persistent Operations Queue">
        <RequestTable requests={requests.data ?? []} allowDelete={canManageRequests(user)} />
      </Panel>
    </Page>
  )
}

function MetricCard({ label, value, Icon, helper, index }: { label: string; value: number | string; Icon: typeof Activity; helper: string; index: number }) {
  return (
    <motion.article className="metric-card" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.04 }}>
      <Icon size={20} />
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{helper}</small>
    </motion.article>
  )
}

function EnterpriseWorkflowBoard({ workflows, selected, onSelect }: { workflows: WorkflowItem[]; selected: { workflow: WorkflowItem; stage: WorkflowStage } | null; onSelect: (value: { workflow: WorkflowItem; stage: WorkflowStage }) => void }) {
  if (!workflows.length) return <EmptyState text="No workflows available. Reset demo data to load an enterprise operations scenario." />
  return (
    <div className="enterprise-workflows">
      {workflows.map((workflow) => (
        <motion.article className="workflow-lane" key={workflow.request.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <header>
            <div><strong>OPS-{String(workflow.request.id).padStart(5, '0')} : {workflow.request.title}</strong><small>{workflow.request.request_type} : {workflow.request.customer_name}</small></div>
            <StatusPill status={workflow.request.status} />
          </header>
          <div className="stage-rail">
            {workflow.stages.map((stage, index) => {
              const active = selected?.workflow.request.id === workflow.request.id && selected.stage.name === stage.name
              return (
                <motion.button
                  type="button"
                  className={cn('stage-node', stage.state.toLowerCase().replaceAll(' ', '-'), active && 'selected')}
                  key={`${workflow.request.id}-${stage.name}`}
                  onClick={() => onSelect({ workflow, stage })}
                  whileHover={{ y: -2 }}
                  animate={{ scale: stage.state === 'Running' ? [1, 1.035, 1] : 1 }}
                  transition={{ duration: 1.5, repeat: stage.state === 'Running' ? Infinity : 0 }}
                >
                  <span>{index + 1}</span>
                  <strong>{stage.name}</strong>
                  <small>{stage.state}</small>
                  {stage.executionTimeMs > 0 && <em>{stage.executionTimeMs}ms : {Math.round(stage.confidence * 100)}%</em>}
                </motion.button>
              )
            })}
          </div>
        </motion.article>
      ))}
    </div>
  )
}

function WorkflowStageDrawer({ selected, onClose }: { selected: { workflow: WorkflowItem; stage: WorkflowStage }; onClose: () => void }) {
  const { workflow, stage } = selected
  return (
    <motion.aside className="stage-drawer" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }}>
      <header>
        <div><p className="eyebrow">Stage Intelligence</p><h3>{stage.name}</h3><small>OPS-{String(workflow.request.id).padStart(5, '0')} : {workflow.request.title}</small></div>
        <button className="icon-button" style={{fontFamily: 'Sans-serif'}} onClick={onClose} aria-label="Close stage details">x</button>
      </header>
      <div className="explain-grid">
        <Evidence label="Agent Name" value={stage.agentName} />
        <Evidence label="Current Status" value={stage.state} />
        <Evidence label="Execution Time" value={stage.executionTimeMs ? `${stage.executionTimeMs}ms` : 'Pending'} />
        <Evidence label="Confidence" value={`${Math.round(stage.confidence * 100)}%`} />
      </div>
      <div className="settings-grid">
        <Evidence label="Business Rules Used" value={stage.businessRules.join(', ') || 'Awaiting retrieval'} />
        <Evidence label="Retrieved SOPs" value={stage.retrievedSops.map((sop) => sop.title).join(', ') || 'No SOP retrieved yet'} />
        <Evidence label="Reasoning Summary" value={stage.reasoning} />
        <Evidence label="Inputs" value={Object.entries(stage.inputs).map(([key, value]) => `${key}: ${value}`).join(', ')} />
        <Evidence label="Outputs" value={stage.outputs.message || stage.outputs.riskFactors?.join(', ') || 'Pending output'} />
      </div>
    </motion.aside>
  )
}

function AgentConversationTimeline({ workflows }: { workflows: WorkflowItem[] }) {
  const conversations = workflows.flatMap((workflow) => workflow.stages
    .filter((stage) => stage.state !== 'Pending')
    .map((stage) => ({ workflow, stage })))
    .slice(0, 16)
  if (!conversations.length) return <SkeletonRows count={5} />
  return (
    <div className="agent-stream conversation-stream">
      {conversations.map(({ workflow, stage }, index) => (
        <motion.div key={`${workflow.request.id}-${stage.name}`} className="stream-row" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: index * 0.03 }}>
          <div className="agent-dot"><BrainCircuit size={16} /></div>
          <div>
            <strong>{stage.agentName}</strong>
            <p>{stage.outputs.message || stage.reasoning}</p>
            <small>{new Date(workflow.request.updated_at).toLocaleTimeString()} : {stage.executionTimeMs || 0}ms</small>
          </div>
          <StatusPill status={stage.state} />
          <span>{Math.round(stage.confidence * 100)}%</span>
        </motion.div>
      ))}
    </div>
  )
}

function AIWorkforceDashboard({ agents }: { agents: Agent[] }) {
  if (!agents.length) return <SkeletonRows count={4} />
  return (
    <div className="workforce-grid">
      {agents.map((agent) => (
        <motion.article className="agent-card" key={agent.id} layout>
          <div className="agent-card-head"><BrainCircuit /><div><strong>{agent.name}:</strong><span> {agent.responsibility}</span></div><StatusPill status={agent.status} /></div>
          <p>{agent.currentTask}</p>
          <div className="agent-stats">
            <Evidence label="Processed" value={`${agent.processedCount}`} />
            <Evidence label="Avg Response" value={`${agent.executionTimeMs}ms`} />
            <Evidence label="Success Rate" value={`${agent.processedCount ? 96 : 0}%`} />
            <Evidence label="Confidence" value={`${Math.round(agent.confidence * 100)}%`} />
          </div>
          <small>{agent.lastDecision}</small>
        </motion.article>
      ))}
    </div>
  )
}

function RecentActivities({ activities }: { activities: Analytics['recentActivities'] }) {
  if (!activities.length) return <EmptyState text="No recent activities recorded." />
  return (
    <div className="timeline">
      {activities.map((activity, index) => (
        <article className="timeline-item" key={`${activity.createdAt}-${index}`}>
          <div><strong>{activity.actor}</strong><p>{activity.action}</p><small>{activity.details}</small></div>
          <span>{new Date(activity.createdAt).toLocaleTimeString()}</span>
        </article>
      ))}
    </div>
  )
}

function RequestTable({ requests, allowDelete = false }: { requests: RequestItem[]; allowDelete?: boolean }) {
  const navigate = useNavigate()
  const query = useQueryClient()
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/requests/${id}`, { method: 'DELETE' }),
    onSuccess: () => query.invalidateQueries({ queryKey: ['requests'] }),
  })
  if (!requests.length) return <EmptyState text="No requests are currently stored in the database." />
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Request</th><th>Priority</th><th>Status</th><th>Risk</th><th>Decision</th>{allowDelete && <th>Actions</th>}</tr></thead>
        <tbody>
          {requests.map((request) => (
            <tr key={request.id} onClick={() => navigate(`/requests/${request.id}`)}>
              <td><strong>{request.title}</strong><small>{request.customer_name} - {request.account_number}</small></td>
              <td><StatusPill status={request.priority} /></td>
              <td><StatusPill status={request.status} /></td>
              <td>{request.risk_score}/100</td>
              <td>{request.decision}</td>
              {allowDelete && <td><button className="icon-button" title="Delete request" onClick={(event) => { event.stopPropagation(); remove.mutate(request.id) }}><Trash2 /></button></td>}
            </tr>
          ))}
        </tbody>
      </table>
      {remove.error && <ErrorText error={remove.error} />}
    </div>
  )
}

function NewRequest() {
  const navigate = useNavigate()
  const query = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [form, setForm] = useState({
    title: '',
    request_type: '',
    customer_name: '',
    account_number: '',
    email: '',
    description: '',
  })
  const create = useMutation({
    mutationFn: async (body: typeof form) => {
      const request = await api<RequestItem>('/api/requests', { method: 'POST', body: JSON.stringify(body) })
      if (file) {
        const payload = new FormData()
        payload.append('file', file)
        await api(`/api/documents/upload?request_id=${request.id}`, { method: 'POST', body: payload })
      }
      return request
    },
    onSuccess: (request) => {
      query.invalidateQueries({ queryKey: ['requests'] })
      navigate(`/requests/${request.id}`, { state: { autoRun: true } })
    },
  })

  return (
    <Page title="New Operations Request" icon={Plus}>
      <section className="form-layout">
        <Panel title="Request Intake">
          <div className="form-grid">
            {Object.entries(form).map(([key, value]) => (
              <label key={key} className={key === 'description' ? 'span-2' : ''}>{key.replaceAll('_', ' ')}
                {key === 'description'
                  ? <textarea value={value} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
                  : <input value={value} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />}
              </label>
            ))}
          </div>
          <button className="primary" onClick={() => create.mutate(form)} disabled={create.isPending}><Play size={18} />{create.isPending ? 'Creating' : 'Create and Orchestrate'}</button>
          {create.error && <ErrorText error={create.error} />}
        </Panel>
        <Panel title="Document Intelligence">
          <label className="upload-zone">
            <Upload />
            <strong>{file ? file.name : 'Upload PDF, DOCX, or TXT evidence'}</strong>
            <span>Uploaded content is extracted, persisted, and attached to the request.</span>
            <input className="file-input" type="file" accept=".pdf,.docx,.txt,text/plain,application/pdf" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </label>
          <div className="evidence-list">
            <Evidence label="Customer Name" value={form.customer_name || 'Not entered'} />
            <Evidence label="Account Number" value={form.account_number || 'Not entered'} />
            <Evidence label="Document" value={file?.name ?? 'No file selected'} />
          </div>
        </Panel>
      </section>
    </Page>
  )
}

function RequestDetailsPage({ user }: { user?: User }) {
  const params = useParams()
  const id = Number(params.id)
  const location = useLocation()
  const navigate = useNavigate()
  const query = useQueryClient()
  const details = useQuery({ queryKey: ['request', id], queryFn: () => api<RequestDetails>(`/api/requests/${id}`), enabled: Number.isFinite(id) })
  const documents = useQuery({ queryKey: ['documents', id], queryFn: () => api<DocumentInfo[]>(`/api/documents?request_id=${id}`), enabled: Number.isFinite(id) })
  const [edit, setEdit] = useState<Partial<RequestItem>>({})
  const [streamedSteps, setStreamedSteps] = useState<Step[]>([])
  const [workflowStatus, setWorkflowStatus] = useState('Idle')
  const [playbackIndex, setPlaybackIndex] = useState(0)
  const [autoRunRequested, setAutoRunRequested] = useState(() => Boolean((location.state as { autoRun?: boolean } | null)?.autoRun))
  const autoRunStartedRef = useRef(false)

  useEffect(() => {
    if (details.data?.request) setEdit(details.data.request)
  }, [details.data?.request])

  const execute = useMutation({
    mutationFn: async () => {
      setStreamedSteps([
        {
          id: -1,
          agentName: 'Workflow Coordinator',
          status: 'Running',
          message: 'Opening the live workflow channel and preparing the agent team.',
          confidence: 0,
          citations: [],
          reasoning: 'The request has been created. OpsFlow AI is connecting to the orchestration service.',
          riskFactors: [],
          createdAt: new Date().toISOString(),
        },
      ])
      setWorkflowStatus('Connecting')
      await streamWorkflow(
        id,
        (step) => setStreamedSteps((current: Step[]) => {
          if (step.status === 'Completed') {
            const runningIndex = current.findIndex((item) => item.agentName === step.agentName && item.status === 'Running')
            if (runningIndex >= 0) {
              return current.map((item, index) => index === runningIndex ? step : item)
            }
          }
          return [...current, step]
        }),
        setWorkflowStatus,
      )
    },
    onSuccess: () => {
      query.invalidateQueries({ queryKey: ['request', id] })
      query.invalidateQueries({ queryKey: ['requests'] })
      query.invalidateQueries({ queryKey: ['metrics'] })
    },
    onError: () => {
      setWorkflowStatus('Failed')
    },
  })

  useEffect(() => {
    if (!autoRunRequested || execute.isPending || !details.data?.request) return
    if (autoRunStartedRef.current) return
    autoRunStartedRef.current = true
    setAutoRunRequested(false)
    navigate(location.pathname, { replace: true })
    execute.mutate()
  }, [autoRunRequested, details.data?.request, execute, location.pathname, navigate])
  const update = useMutation({
    mutationFn: () => api<RequestItem>(`/api/requests/${id}`, { method: 'PUT', body: JSON.stringify(edit) }),
    onSuccess: () => {
      query.invalidateQueries({ queryKey: ['request', id] })
      query.invalidateQueries({ queryKey: ['requests'] })
    },
  })
  const remove = useMutation({
    mutationFn: () => api(`/api/requests/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      query.invalidateQueries({ queryKey: ['requests'] })
      navigate('/requests')
    },
  })
  const approval = details.data?.approvals.find((item) => item.status === 'Pending') ?? details.data?.approvals[0]
  const playbackSteps = streamedSteps.length ? streamedSteps : details.data?.steps ?? []
  const selectedPlayback = playbackSteps[Math.min(playbackIndex, Math.max(playbackSteps.length - 1, 0))]
  const canOperate = canCreateRequests(user)
  const canDelete = canManageRequests(user)

  return (
    <Page title={details.data?.request.title ?? 'Request Details'} icon={FileSearch}>
      <QueryState queries={[details, documents]} />
      {details.data && (
        <>
          <section className="detail-header">
            <div><p className="eyebrow">OPS-{String(id).padStart(5, '0')}</p><h3>{details.data.request.customer_name}</h3><p className="muted">{details.data.request.description}</p></div>
            <div className="decision-box"><Gauge /><strong>{details.data.request.risk_score}/100</strong><span>Risk score</span></div>
            <div className="button-row">
              {canOperate && <button className="primary" onClick={() => execute.mutate()} disabled={execute.isPending}><Play size={18} />{execute.isPending ? 'Running Workflow' : 'Run Workflow'}</button>}
              <StatusPill status={workflowStatus} />
              {canDelete && <button className="danger" onClick={() => remove.mutate()} disabled={remove.isPending}><Trash2 size={18} />Delete</button>}
            </div>
          </section>
          {execute.error && <ErrorText error={execute.error} />}
          <section className="dashboard-grid">
            <Panel title="Explainable AI Decision">
              <div className="explain-grid">
                <Evidence label="Decision" value={details.data.request.decision} />
                <Evidence label="Confidence" value={`${Math.round(details.data.request.confidence * 100)}%`} />
                <Evidence label="Policy Used" value={details.data.steps.flatMap((step) => step.citations)[0]?.title ?? 'No citation retrieved'} />
                <Evidence label="Risk Factor" value={details.data.steps.flatMap((step) => step.riskFactors)[0] ?? 'No risk factors recorded'} />
              </div>
              {approval && canManageRequests(user) && <HumanApproval approvalId={approval.id} summary={approval.managerSummary} request={details.data.request} steps={playbackSteps} requestId={id} />}
            </Panel>
            <Panel title="Request Playback">
              <RequestPlayback steps={playbackSteps} index={playbackIndex} setIndex={setPlaybackIndex} />
            </Panel>
          </section>
          <section className="dashboard-grid">
            <Panel title="Edit Request">
              <div className="form-grid">
                {['title', 'request_type', 'customer_name', 'account_number', 'email', 'description'].map((key) => (
                  <label key={key} className={key === 'description' ? 'span-2' : ''}>{key.replaceAll('_', ' ')}
                    {key === 'description'
                      ? <textarea value={String(edit[key as keyof RequestItem] ?? '')} onChange={(event) => setEdit({ ...edit, [key]: event.target.value })} />
                      : <input value={String(edit[key as keyof RequestItem] ?? '')} onChange={(event) => setEdit({ ...edit, [key]: event.target.value })} />}
                  </label>
                ))}
              </div>
              {canOperate ? <button className="primary" onClick={() => update.mutate()} disabled={update.isPending}>Save Changes</button> : <EmptyState text="Read-only access for this request." />}
              <MutationErrors mutations={[update, remove]} />
            </Panel>
            <Panel title="Documents">
              <DocumentManager requestId={id} documents={documents.data ?? []} canManage={canOperate} canPreview={canPreviewDocuments(user)} />
            </Panel>
          </section>
          <Panel title="Agent Activity Timeline">
            <div className="timeline">
              {playbackSteps.map((step) => (
                <article key={step.id} className="timeline-item">
                  <div><strong>{step.agentName}</strong><p>{step.message}</p><small>{step.reasoning}</small></div>
                  <StatusPill status={`${Math.round(step.confidence * 100)}%`} />
                </article>
              ))}
            </div>
          </Panel>
          {selectedPlayback && (
            <Panel title="Playback Evidence">
              <div className="explain-grid">
                <Evidence label="Agent" value={selectedPlayback.agentName} />
                <Evidence label="Confidence" value={`${Math.round(selectedPlayback.confidence * 100)}%`} />
                <Evidence label="Reasoning" value={selectedPlayback.reasoning} />
                <Evidence label="Evidence" value={selectedPlayback.citations[0]?.title ?? selectedPlayback.riskFactors[0] ?? 'No evidence recorded'} />
              </div>
            </Panel>
          )}
        </>
      )}
    </Page>
  )
}

function RequestPlayback({ steps, index, setIndex }: { steps: Step[]; index: number; setIndex: (value: number) => void }) {
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!playing || !steps.length) return
    const timer = window.setInterval(() => setIndex(index >= steps.length - 1 ? 0 : index + 1), 1300)
    return () => window.clearInterval(timer)
  }, [playing, steps.length, index, setIndex])
  if (!steps.length) return <EmptyState text="Run a workflow to record playback steps." />
  const step = steps[Math.min(index, steps.length - 1)]
  return (
    <div className="playback-panel">
      <div className="button-row">
        <button className="primary" onClick={() => setPlaying(!playing)}>{playing ? <PauseCircle size={18} /> : <Play size={18} />}{playing ? 'Pause' : 'Play'}</button>
        <input type="range" min={0} max={steps.length - 1} value={Math.min(index, steps.length - 1)} onChange={(event) => setIndex(Number(event.target.value))} />
      </div>
      <motion.div className="stream-row playback-row" key={step.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <div className="agent-dot"><BrainCircuit size={16} /></div>
        <div><strong>{step.agentName}</strong><p>{step.message}</p><small>{step.reasoning}</small></div>
        <span>{Math.round(step.confidence * 100)}%</span>
      </motion.div>
    </div>
  )
}

function DocumentManager({ requestId, documents, canManage, canPreview }: { requestId: number; documents: DocumentInfo[]; canManage: boolean; canPreview: boolean }) {
  const query = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [selectedDocumentId, setSelectedDocumentId] = useState<number | null>(null)
  const preview = useQuery({
    queryKey: ['document-preview', selectedDocumentId],
    queryFn: () => api<DocumentInfo>(`/api/documents/${selectedDocumentId}`),
    enabled: canPreview && selectedDocumentId !== null,
  })
  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Select a document first')
      const payload = new FormData()
      payload.append('file', file)
      return api(`/api/documents/upload?request_id=${requestId}`, { method: 'POST', body: payload })
    },
    onSuccess: () => {
      setFile(null)
      query.invalidateQueries({ queryKey: ['documents', requestId] })
    },
  })
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/documents/${id}`, { method: 'DELETE' }),
    onSuccess: () => query.invalidateQueries({ queryKey: ['documents', requestId] }),
  })
  return (
    <div className="knowledge-list">
      {canManage && (
        <>
          <label className="upload-zone">
            <Upload />
            <strong>{file?.name ?? 'Attach another document'}</strong>
            <input className="file-input" type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </label>
          <button className="primary" onClick={() => upload.mutate()} disabled={upload.isPending}>Upload Document</button>
        </>
      )}
      {documents.length ? documents.map((doc) => (
        <div
          className={`evidence row-evidence ${canPreview ? 'clickable-row' : ''}`}
          key={doc.id}
          role={canPreview ? 'button' : undefined}
          tabIndex={canPreview ? 0 : undefined}
          onClick={canPreview ? () => setSelectedDocumentId(doc.id) : undefined}
          onKeyDown={canPreview ? (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setSelectedDocumentId(doc.id)
            }
          } : undefined}
        >
          <div><span>{doc.filename}</span><strong>{doc.summary || doc.documentType}</strong></div>
          {canManage && <button className="icon-button" onClick={(event) => { event.stopPropagation(); remove.mutate(doc.id) }} title="Delete document"><Trash2 /></button>}
        </div>
      )) : <EmptyState text="No documents attached to this request." />}
      {selectedDocumentId !== null && (
        <DocumentPreviewModal
          title={preview.data?.filename ?? 'Document Preview'}
          subtitle={preview.data?.documentType}
          content={preview.data?.extractedText ?? ''}
          summary={preview.data?.summary}
          entities={preview.data?.entities}
          isLoading={preview.isLoading}
          error={preview.error}
          onClose={() => setSelectedDocumentId(null)}
        />
      )}
      <MutationErrors mutations={[upload, remove]} />
    </div>
  )
}

function HumanApproval({ approvalId, summary, request, steps, requestId }: { approvalId: number; summary: string; request: RequestItem; steps: Step[]; requestId: number }) {
  const query = useQueryClient()
  const [notes, setNotes] = useState('')
  const decide = useMutation({
    mutationFn: (decision: string) => api(`/api/approvals/${approvalId}/decision`, { method: 'POST', body: JSON.stringify({ decision, notes }) }),
    onSuccess: () => {
      query.invalidateQueries({ queryKey: ['request', requestId] })
      query.invalidateQueries({ queryKey: ['requests'] })
      query.invalidateQueries({ queryKey: ['metrics'] })
    },
  })
  const policies = Array.from(new Set(steps.flatMap((step) => step.citations.map((citation) => citation.title)))).slice(0, 3)
  const missing = Array.from(new Set(steps.flatMap((step) => step.riskFactors))).slice(0, 3)
  return (
    <div className="approval-box">
      <AlertTriangle />
      <div>
        <strong>Human Approval Required</strong>
        <p>{summary}</p>
        <div className="explain-grid">
          <Evidence label="Confidence Score" value={`${Math.round(request.confidence * 100)}%`} />
          <Evidence label="Risk Score" value={`${request.risk_score}/100`} />
          <Evidence label="Policies Used" value={policies.join(', ') || 'No policy citation recorded'} />
          <Evidence label="Missing Information" value={missing.join(', ') || 'No missing information recorded'} />
          <Evidence label="AI Recommendation" value={request.decision} />
        </div>
        <input value={notes} onChange={(event) => setNotes(event.target.value)} aria-label="Approval notes" placeholder="Manager decision notes" />
      </div>
      <button className="success" onClick={() => decide.mutate('Approved')}>Approve</button>
      <button className="danger" onClick={() => decide.mutate('Rejected')}>Reject</button>
      <button className="ghost" onClick={() => decide.mutate('Request More Information')}>Request Info</button>
      {decide.error && <ErrorText error={decide.error} />}
    </div>
  )
}

function KnowledgeCenter({ user }: { user?: User }) {
  const query = useQueryClient()
  const [q, setQ] = useState('')
  const [form, setForm] = useState({ title: '', category: '', source: 'Internal Knowledge Base', content: '' })
  const [selectedKnowledgeId, setSelectedKnowledgeId] = useState<number | null>(null)
  const knowledge = useQuery({ queryKey: ['knowledge'], queryFn: () => api<KnowledgeItem[]>('/api/knowledge') })
  const search = useQuery({
    queryKey: ['knowledge-search', q],
    queryFn: () => api<KnowledgeItem[]>(`/api/knowledge/search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length > 1,
  })
  const create = useMutation({
    mutationFn: () => api<KnowledgeItem>('/api/knowledge/upload', { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: () => {
      setForm({ title: '', category: '', source: 'Internal Knowledge Base', content: '' })
      query.invalidateQueries({ queryKey: ['knowledge'] })
    },
  })
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/knowledge/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      query.invalidateQueries({ queryKey: ['knowledge'] })
      query.invalidateQueries({ queryKey: ['knowledge-search'] })
    },
  })
  const shown = q.trim().length > 1 ? search.data ?? [] : knowledge.data ?? []
  const canManage = canManageKnowledge(user)
  const canPreview = canPreviewDocuments(user)
  const preview = useQuery({
    queryKey: ['knowledge-preview', selectedKnowledgeId],
    queryFn: () => api<KnowledgeItem>(`/api/knowledge/${selectedKnowledgeId}`),
    enabled: canPreview && selectedKnowledgeId !== null,
  })
  return (
    <Page title="Knowledge Center" icon={Database}>
      <QueryState queries={[knowledge]} />
      <section className="dashboard-grid">
        <Panel title="Enterprise Retrieval">
          <div className="search-box"><Search /><input value={q} onChange={(event) => setQ(event.target.value)} /></div>
          <div className="knowledge-list">
            {shown.length ? shown.map((item) => (
              <div
                className={`evidence row-evidence ${canPreview ? 'clickable-row' : ''}`}
                key={item.id}
                role={canPreview ? 'button' : undefined}
                tabIndex={canPreview ? 0 : undefined}
                onClick={canPreview ? () => setSelectedKnowledgeId(item.id) : undefined}
                onKeyDown={canPreview ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setSelectedKnowledgeId(item.id)
                  }
                } : undefined}
              >
                <div><span>{item.title} : </span><strong>{item.category} - {item.score !== undefined ? `score ${item.score}` : item.source}</strong></div>
                {canManageRequests(user) && <button className="icon-button" onClick={(event) => { event.stopPropagation(); remove.mutate(item.id) }} title="Delete knowledge item"><Trash2 /></button>}
              </div>
            )) : <EmptyState text="No knowledge records match the current query." />}
          </div>
          <MutationErrors mutations={[remove]} />
        </Panel>
        {canManage && (
          <Panel title="Upload Policy or SOP">
            <div className="form-grid">
              {Object.entries(form).map(([key, value]) => (
                <label key={key} className={key === 'content' ? 'span-2' : ''}>{key}
                  {key === 'content'
                    ? <textarea value={value} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
                    : <input value={value} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />}
                </label>
              ))}
            </div>
            <button className="primary" onClick={() => create.mutate()} disabled={create.isPending}>Persist Knowledge</button>
            <MutationErrors mutations={[create]} />
          </Panel>
        )}
      </section>
      {selectedKnowledgeId !== null && (
        <DocumentPreviewModal
          title={preview.data?.title ?? 'Knowledge Document'}
          subtitle={preview.data ? `${preview.data.category} : ${preview.data.source}` : undefined}
          content={preview.data?.content ?? ''}
          isLoading={preview.isLoading}
          error={preview.error}
          onClose={() => setSelectedKnowledgeId(null)}
        />
      )}
    </Page>
  )
}

function DocumentPreviewModal({
  title,
  subtitle,
  content,
  summary,
  entities,
  isLoading,
  error,
  onClose,
}: {
  title: string
  subtitle?: string
  content: string
  summary?: string
  entities?: Record<string, string>
  isLoading: boolean
  error: Error | null
  onClose: () => void
}) {
  return (
    <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={onClose}>
      <motion.section
        className="document-modal"
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <div>
            <p className="eyebrow">{subtitle ?? 'Document Preview'}</p>
            <h3>{title}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close document preview"><X /></button>
        </header>
        {isLoading && <div className="skeleton document-skeleton" />}
        {error && <ErrorText error={error} />}
        {!isLoading && !error && (
          <>
            {summary && <Evidence label="Summary" value={summary} />}
            {entities && Object.keys(entities).length > 0 && (
              <div className="entity-grid">
                {Object.entries(entities).map(([key, value]) => <Evidence key={key} label={key} value={value} />)}
              </div>
            )}
            <pre className="document-content">{content || 'No extracted document text is available.'}</pre>
          </>
        )}
      </motion.section>
    </motion.div>
  )
}

function AnalyticsPage() {
  const analytics = useQuery({ queryKey: ['analytics'], queryFn: () => api<Analytics>('/api/analytics') })
  const metrics = useQuery({ queryKey: ['metrics'], queryFn: () => api<MetricMap>('/api/dashboard/metrics') })
  const requests = useQuery({ queryKey: ['requests'], queryFn: () => api<RequestItem[]>('/api/requests') })
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: () => api<WorkflowItem[]>('/api/workflows') })
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api<Agent[]>('/api/agents'), retry: false })
  const requestRows = requests.data ?? []
  const workflowRows = workflows.data ?? []
  const priorityData = ['Critical', 'High', 'Medium', 'Low'].map((name) => ({ name, value: requestRows.filter((request) => request.priority === name).length }))
  const statusData = ['Pending', 'Running', 'Waiting Human Approval', 'Exception Raised', 'Completed', 'Failed'].map((name) => ({ name, value: requestRows.filter((request) => request.status === name).length }))
  const confidenceBands = [
    { name: '0-49%', value: requestRows.filter((request) => request.confidence > 0 && request.confidence < 0.5).length },
    { name: '50-74%', value: requestRows.filter((request) => request.confidence >= 0.5 && request.confidence < 0.75).length },
    { name: '75-89%', value: requestRows.filter((request) => request.confidence >= 0.75 && request.confidence < 0.9).length },
    { name: '90%+', value: requestRows.filter((request) => request.confidence >= 0.9).length },
  ]
  const stageHealth = workflowRows.flatMap((workflow) => workflow.stages).reduce<Record<string, { name: string; completed: number; running: number; blocked: number; pending: number }>>((acc, stage) => {
    acc[stage.name] ??= { name: stage.name, completed: 0, running: 0, blocked: 0, pending: 0 }
    if (stage.state === 'Completed') acc[stage.name].completed += 1
    else if (stage.state === 'Running') acc[stage.name].running += 1
    else if (['Exception', 'Failed', 'Waiting Approval'].includes(stage.state)) acc[stage.name].blocked += 1
    else acc[stage.name].pending += 1
    return acc
  }, {})
  const agentPerformance = (agents.data ?? []).map((agent) => ({
    name: agent.name.replace(' Agent', ''),
    processed: agent.processedCount,
    response: agent.executionTimeMs,
    confidence: Math.round(agent.confidence * 100),
  }))
  const processQuality = [
    { name: 'SLA', value: metrics.data?.slaPerformance ?? 0 },
    { name: 'Approvals', value: metrics.data?.approvalRate ?? 0 },
    { name: 'Utilization', value: metrics.data?.agentUtilization ?? 0 },
    { name: 'Low Risk', value: Math.max(0, 100 - ((metrics.data?.highRiskRequests ?? 0) * 12)) },
  ]
  const kpis = [
    ['Requests Today', metrics.data?.todaysRequests ?? 0, Activity, 'New intake volume'],
    ['Running Workflows', metrics.data?.runningWorkflows ?? 0, Play, 'Currently orchestrating'],
    ['Pending Approvals', metrics.data?.pendingApprovals ?? 0, ShieldCheck, 'Manager actions'],
    ['Exceptions', metrics.data?.exceptions ?? 0, AlertTriangle, 'Blocked operations'],
    ['Average SLA', metrics.data?.averageSla ?? '-', Gauge, 'Target window'],
    ['Avg Resolution', metrics.data?.averageResolutionTime ?? '-', CheckCircle2, 'Completed requests'],
    ['Agent Utilization', `${metrics.data?.agentUtilization ?? 0}%`, BrainCircuit, 'Digital workforce load'],
    ['High Risk', metrics.data?.highRiskRequests ?? 0, BarChart3, 'Risk score >= 60'],
  ] as const
  return (
    <Page title="Analytics" icon={BarChart3}>
      <QueryState queries={[analytics, metrics, requests, workflows]} />
      <section className="control-hero analytics-hero">
        <div>
          <p className="eyebrow">Operations Intelligence</p>
          <h2>Process health, risk, SLA, and agent performance in one command view.</h2>
          <p className="muted">Analytics are computed from persisted requests, workflow stages, audit events, approvals, and AI workforce activity.</p>
        </div>
        <div className="hero-indicators">
          <Evidence label="Tracked Workflows" value={`${workflowRows.length}`} />
          <Evidence label="Automation Coverage" value={`${Math.round(((metrics.data?.completedRequests ?? 0) / Math.max(requestRows.length, 1)) * 100)}%`} />
        </div>
      </section>
      <section className="metric-grid">
        {metrics.isLoading ? <SkeletonCards count={8} /> : kpis.map(([label, value, Icon, helper], index) => <MetricCard key={label} label={label} value={value} Icon={Icon} helper={helper} index={index} />)}
      </section>
      <section className="dashboard-grid">
        <Panel title="Request Categories">
          <ResponsiveContainer width="100%" height={360}><BarChart data={analytics.data?.categories ?? []} margin={{ bottom: 54 }}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" angle={-28} textAnchor="end" interval={0} height={70} /><YAxis /><Tooltip /><Bar dataKey="value" fill="#2563eb" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer>
        </Panel>
        <Panel title="SLA Performance">
          <ResponsiveContainer width="100%" height={320}><AreaChart data={analytics.data?.slaTrend ?? []}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="day" /><YAxis /><Tooltip /><Area dataKey="met" stroke="#14b8a6" fill="#14b8a633" /><Area dataKey="missed" stroke="#ef4444" fill="#ef444433" /></AreaChart></ResponsiveContainer>
        </Panel>
      </section>
      <section className="analytics-grid">
        <Panel title="Workflow Status Funnel">
          <ResponsiveContainer width="100%" height={280}><BarChart data={statusData} layout="vertical"><CartesianGrid strokeDasharray="3 3" /><XAxis type="number" /><YAxis type="category" dataKey="name" width={140} /><Tooltip /><Bar dataKey="value" fill="#14b8a6" radius={[0, 6, 6, 0]} /></BarChart></ResponsiveContainer>
        </Panel>
        <Panel title="Risk Distribution">
          <ResponsiveContainer width="100%" height={280}><PieChart><Pie data={analytics.data?.riskDistribution ?? []} dataKey="value" nameKey="name" innerRadius={58} outerRadius={96}>{['#14b8a6', '#f59e0b', '#ef4444'].map((color) => <Cell key={color} fill={color} />)}</Pie><Tooltip /><Legend /></PieChart></ResponsiveContainer>
        </Panel>
        <Panel title="Priority Mix">
          <ResponsiveContainer width="100%" height={280}><BarChart data={priorityData}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" /><YAxis /><Tooltip /><Bar dataKey="value" fill="#8b5cf6" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer>
        </Panel>
      </section>
      <section className="dashboard-grid">
        <Panel title="Stage Health Across Workflows">
          <ResponsiveContainer width="100%" height={380}><BarChart data={Object.values(stageHealth)} margin={{ bottom: 58 }}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" angle={-28} textAnchor="end" interval={0} height={72} /><YAxis /><Tooltip /><Legend /><Bar dataKey="completed" stackId="a" fill="#16a34a" /><Bar dataKey="running" stackId="a" fill="#2563eb" /><Bar dataKey="blocked" stackId="a" fill="#f59e0b" /><Bar dataKey="pending" stackId="a" fill="#94a3b8" /></BarChart></ResponsiveContainer>
        </Panel>
        <Panel title="Confidence Distribution">
          <ResponsiveContainer width="100%" height={340}><AreaChart data={confidenceBands}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" /><YAxis /><Tooltip /><Area dataKey="value" stroke="#2563eb" fill="#2563eb33" /></AreaChart></ResponsiveContainer>
        </Panel>
      </section>
      <section className="dashboard-grid">
        <Panel title="Process Quality Index">
          <ResponsiveContainer width="100%" height={300}><BarChart data={processQuality}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" /><YAxis domain={[0, 100]} /><Tooltip /><Bar dataKey="value" fill="#14b8a6" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer>
        </Panel>
        <Panel title="Agent Throughput and Confidence">
          {agents.error ? <EmptyState text="Agent performance analytics are available to manager and administrator roles." /> : <ResponsiveContainer width="100%" height={340}><BarChart data={agentPerformance} margin={{ bottom: 52 }}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" angle={-28} textAnchor="end" interval={0} height={64} /><YAxis /><Tooltip /><Legend /><Bar dataKey="processed" fill="#2563eb" radius={[6, 6, 0, 0]} /><Bar dataKey="confidence" fill="#14b8a6" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer>}
        </Panel>
      </section>
      <section className="dashboard-grid">
        <Panel title="Operational Risk Leaderboard">
          <div className="analytics-list">
            {[...requestRows].sort((a, b) => b.risk_score - a.risk_score).slice(0, 6).map((request) => (
              <div className="evidence row-evidence" key={request.id}>
                <div><span>OPS-{String(request.id).padStart(5, '0')} : </span><strong>{request.title}</strong><small> : {request.status} : {request.priority}</small></div>
                <StatusPill status={`${request.risk_score}/100`} />
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Recent Analytics Events">
          <RecentActivities activities={analytics.data?.recentActivities ?? []} />
        </Panel>
      </section>
    </Page>
  )
}

function AuditLogs() {
  const logs = useQuery({ queryKey: ['audit'], queryFn: () => api<AuditLogItem[]>('/api/audit') })
  const [filters, setFilters] = useState({ search: '', actor: 'All', action: 'All', requestId: '', from: '', to: '' })
  const rows = logs.data ?? []
  const actors = ['All', ...Array.from(new Set(rows.map((log) => log.actor))).sort()]
  const actions = ['All', ...Array.from(new Set(rows.map((log) => log.action))).sort()]
  const filtered = rows.filter((log) => {
    const created = new Date(log.createdAt)
    const text = `${log.actor} ${log.action} ${log.details} ${log.requestId ?? ''}`.toLowerCase()
    if (filters.search && !text.includes(filters.search.toLowerCase())) return false
    if (filters.actor !== 'All' && log.actor !== filters.actor) return false
    if (filters.action !== 'All' && log.action !== filters.action) return false
    if (filters.requestId && String(log.requestId ?? '').padStart(5, '0') !== filters.requestId.padStart(5, '0')) return false
    if (filters.from && created < new Date(`${filters.from}T00:00:00`)) return false
    if (filters.to && created > new Date(`${filters.to}T23:59:59`)) return false
    return true
  })
  return (
    <Page title="Audit Logs" icon={ShieldCheck}>
      <QueryState queries={[logs]} />
      <Panel title="Audit Filters">
        <div className="audit-filters">
          <label>Search<input value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} placeholder="Actor, action, details..." /></label>
          <label>Actor<select value={filters.actor} onChange={(event) => setFilters({ ...filters, actor: event.target.value })}>{actors.map((actor) => <option key={actor}>{actor}</option>)}</select></label>
          <label>Action<select value={filters.action} onChange={(event) => setFilters({ ...filters, action: event.target.value })}>{actions.map((action) => <option key={action}>{action}</option>)}</select></label>
          <label>Request ID<input value={filters.requestId} onChange={(event) => setFilters({ ...filters, requestId: event.target.value.replace(/\D/g, '') })} placeholder="00001" /></label>
          <label>From<input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
          <label>To<input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label>
        </div>
        <div className="button-row">
          <StatusPill status={`${filtered.length} records`} />
          <button className="ghost" onClick={() => setFilters({ search: '', actor: 'All', action: 'All', requestId: '', from: '', to: '' })}>Clear Filters</button>
        </div>
      </Panel>
      <Panel title="Decision History and Evidence Tracking">
        {filtered.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Timestamp</th><th>Request</th><th>Actor</th><th>Action</th><th>Details</th></tr>
              </thead>
              <tbody>
                {filtered.map((log) => (
                  <tr key={log.id}>
                    <td><strong>{new Date(log.createdAt).toLocaleDateString()}</strong><small>{new Date(log.createdAt).toLocaleTimeString()}</small></td>
                    <td>{log.requestId ? `OPS-${String(log.requestId).padStart(5, '0')}` : 'Platform'}</td>
                    <td>{log.actor}</td>
                    <td><StatusPill status={log.action} /></td>
                    <td>{log.details}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState text="No audit events match the selected filters." />}
      </Panel>
    </Page>
  )
}

function AgentMonitoring() {
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api<Agent[]>('/api/agents') })
  const runtime = useQuery({ queryKey: ['agent-runtime'], queryFn: () => api<AgentRuntime>('/api/agents/runtime') })
  return (
    <Page title="AI Workforce Dashboard" icon={BrainCircuit}>
      <QueryState queries={[agents, runtime]} />
      <Panel title="Runtime">
        <div className="settings-grid">
          <Evidence label="Mode" value={runtime.data?.mode ?? 'Loading'} />
          <Evidence label="Capabilities" value={(runtime.data?.supports ?? []).join(', ') || 'Loading'} />
        </div>
      </Panel>
      <section className="agent-grid">
        {agents.data?.map((agent) => (
          <article key={agent.id} className="agent-card">
            <div className="agent-card-head"><BrainCircuit /><div><strong>{agent.name}:</strong><span> {agent.responsibility}</span></div><StatusPill status={agent.status} /></div>
            <p>{agent.currentTask}</p>
            <div className="agent-stats"><Evidence label="Confidence" value={`${Math.round(agent.confidence * 100)}%`} /><Evidence label="Execution" value={`${agent.executionTimeMs}ms`} /><Evidence label="Processed" value={`${agent.processedCount}`} /></div>
          </article>
        ))}
      </section>
    </Page>
  )
}

function UserManagement() {
  const query = useQueryClient()
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/api/users') })
  const [form, setForm] = useState<UserForm>({
    name: '',
    email: '',
    password: '',
    role: 'Operations Executive',
    department: 'Operations',
    is_active: true,
  })
  const [editingId, setEditingId] = useState<number | null>(null)
  const create = useMutation({
    mutationFn: () => api<User>('/api/users', { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: () => {
      setForm({ name: '', email: '', password: '', role: 'Operations Executive', department: 'Operations', is_active: true })
      query.invalidateQueries({ queryKey: ['users'] })
    },
  })
  const update = useMutation({
    mutationFn: (user: User) => {
      const body = { name: user.name, email: user.email, role: user.role, department: user.department, is_active: user.is_active }
      return api<User>(`/api/users/${user.id}`, { method: 'PUT', body: JSON.stringify(body) })
    },
    onSuccess: () => {
      setEditingId(null)
      query.invalidateQueries({ queryKey: ['users'] })
      query.invalidateQueries({ queryKey: ['me'] })
    },
  })
  const resetPassword = useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) => api<User>(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify({ password }) }),
    onSuccess: () => query.invalidateQueries({ queryKey: ['users'] }),
  })
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => query.invalidateQueries({ queryKey: ['users'] }),
  })
  return (
    <Page title="User Management" icon={Users}>
      <QueryState queries={[users]} />
      <section className="dashboard-grid">
        <Panel title="Create User">
          <div className="form-grid">
            <label>Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
            <label>Email<input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
            <label>Password<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
            <label>Department<input value={form.department} onChange={(event) => setForm({ ...form, department: event.target.value })} /></label>
            <label>Role<select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>{roleOptions.map((role) => <option key={role}>{role}</option>)}</select></label>
            <label>Active<select value={String(form.is_active)} onChange={(event) => setForm({ ...form, is_active: event.target.value === 'true' })}><option value="true">Active</option><option value="false">Inactive</option></select></label>
          </div>
          <button className="primary" onClick={() => create.mutate()} disabled={create.isPending}><Plus size={18} />Create User</button>
          <MutationErrors mutations={[create]} />
        </Panel>
        <Panel title="Role Matrix">
          <div className="settings-grid">
            <Evidence label="Administrator" value="Full access and user management" />
            <Evidence label="Operations Manager" value="All requests, approvals, audit, agents" />
            <Evidence label="Operations Executive" value="Create and operate assigned requests" />
            <Evidence label="Viewer" value="Read-only operational visibility" />
          </div>
        </Panel>
      </section>
      <Panel title="Users">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Department</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {(users.data ?? []).map((item) => {
                const editing = editingId === item.id
                return (
                  <tr key={item.id}>
                    <td>{editing ? <input value={item.name} onChange={(event) => query.setQueryData<User[]>(['users'], (current) => current?.map((user) => user.id === item.id ? { ...user, name: event.target.value } : user))} /> : <strong>{item.name}</strong>}</td>
                    <td>{editing ? <input value={item.email} onChange={(event) => query.setQueryData<User[]>(['users'], (current) => current?.map((user) => user.id === item.id ? { ...user, email: event.target.value } : user))} /> : item.email}</td>
                    <td>{editing ? <select value={item.role} onChange={(event) => query.setQueryData<User[]>(['users'], (current) => current?.map((user) => user.id === item.id ? { ...user, role: event.target.value } : user))}>{roleOptions.map((role) => <option key={role}>{role}</option>)}</select> : <StatusPill status={item.role} />}</td>
                    <td>{editing ? <input value={item.department} onChange={(event) => query.setQueryData<User[]>(['users'], (current) => current?.map((user) => user.id === item.id ? { ...user, department: event.target.value } : user))} /> : item.department}</td>
                    <td><StatusPill status={item.is_active ? 'Active' : 'Inactive'} /></td>
                    <td>
                      <div className="button-row">
                        {editing
                          ? <button className="primary" onClick={() => update.mutate(item)} disabled={update.isPending}>Save</button>
                          : <button className="ghost" onClick={() => setEditingId(item.id)}>Edit</button>}
                        <button className="ghost" onClick={() => update.mutate({ ...item, is_active: !item.is_active })}>{item.is_active ? 'Deactivate' : 'Activate'}</button>
                        <button className="ghost" onClick={() => {
                          const password = window.prompt('Enter a new password with at least 8 characters')
                          if (password) resetPassword.mutate({ id: item.id, password })
                        }}>Reset Password</button>
                        <button className="danger" onClick={() => remove.mutate(item.id)} disabled={remove.isPending}><Trash2 size={16} />Delete</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <MutationErrors mutations={[update, resetPassword, remove]} />
      </Panel>
    </Page>
  )
}

function SettingsPage() {
  const metrics = useQuery({ queryKey: ['metrics'], queryFn: () => api<MetricMap>('/api/dashboard/metrics') })
  const runtime = useQuery({ queryKey: ['agent-runtime'], queryFn: () => api<AgentRuntime>('/api/agents/runtime') })
  return (
    <Page title="Settings" icon={Settings}>
      <QueryState queries={[metrics, runtime]} />
      <Panel title="Governance Controls">
        <div className="settings-grid">
          <Evidence label="Confidence threshold" value="Configured by backend environment" />
          <Evidence label="Approval rate" value={`${metrics.data?.approvalRate ?? 0}%`} />
          <Evidence label="Agent runtime" value={runtime.data?.mode ?? 'Loading'} />
          <Evidence label="Database" value="SQLAlchemy persistence layer" />
        </div>
      </Panel>
    </Page>
  )
}

function ProfilePage({ user, onLogout }: { user?: User; onLogout: () => void }) {
  const query = useQueryClient()
  const [form, setForm] = useState({ name: '', email: '', department: '', password: '' })
  useEffect(() => {
    if (user) setForm({ name: user.name, email: user.email, department: user.department, password: '' })
  }, [user])
  const update = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name,
        email: form.email,
        department: form.department,
        ...(form.password ? { password: form.password } : {}),
      }
      return api<User>('/api/profile', { method: 'PUT', body: JSON.stringify(payload) })
    },
    onSuccess: () => {
      setForm((current) => ({ ...current, password: '' }))
      query.invalidateQueries({ queryKey: ['me'] })
      window.alert('Profile updated')
      window.location.reload()
    },
  })
  const deactivate = useMutation({
    mutationFn: () => api('/api/profile', { method: 'DELETE' }),
    onSuccess: () => onLogout(),
  })
  return (
    <Page title="Profile" icon={UserCircle}>
      <Panel title="Signed-in Operator">
        {user ? <div className="profile-card"><UserCircle size={52} /><div><h3>{user.name}</h3><p>{user.email}</p><StatusPill status={user.role} /><p className="muted">{user.department}</p></div></div> : <EmptyState text="Resolving signed-in operator." />}
      </Panel>
      <Panel title="Profile Settings">
        {user ? (
          <>
            <div className="form-grid">
              <label>Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
              <label>Email<input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
              <label>Department<input value={form.department} onChange={(event) => setForm({ ...form, department: event.target.value })} /></label>
              <label>New Password<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="Leave blank to keep current password" /></label>
              <Evidence label="Role" value={`${user.role} (managed by Administrator)`} />
              <Evidence label="Account Status" value={user.is_active ? 'Active' : 'Inactive'} />
            </div>
            <div className="button-row">
              <button className="primary" onClick={() => update.mutate()} disabled={update.isPending}>Save Profile</button>
              <button className="danger" onClick={() => deactivate.mutate()} disabled={deactivate.isPending || user.role === 'Administrator'}><Trash2 size={16} />Deactivate My Account</button>
            </div>
            {user.role === 'Administrator' && <p className="muted pt-4">Administrator self-deactivation is disabled to preserve platform governance access.</p>}
            <MutationErrors mutations={[update, deactivate]} />
          </>
        ) : <EmptyState text="Resolving profile settings." />}
      </Panel>
    </Page>
  )
}

function Page({ title, icon: Icon, children }: { title: string; icon: typeof Activity; children: ReactNode }) {
  return (
    <main className="page">
      <motion.div className="page-title" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <Icon /><div><p className="eyebrow">OpsFlow AI</p><h1>{title}</h1></div>
      </motion.div>
      {children}
    </main>
  )
}

function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="panel"><header><h3>{title}</h3>{action}</header>{children}</section>
}

function Evidence({ label, value }: { label: string; value: string }) {
  return <div className="evidence"><span>{label}</span><strong>{value}</strong></div>
}

function StatusPill({ status }: { status: string }) {
  const lower = status.toLowerCase()
  return <span className={cn('pill', lower.includes('high') || lower.includes('exception') || lower.includes('reject') ? 'risk' : lower.includes('complete') || lower.includes('approve') || lower.includes('low') ? 'ok' : lower.includes('waiting') || lower.includes('medium') ? 'warn' : 'info')}>{status}</span>
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <div className="skeleton-list">
      {Array.from({ length: count }).map((_, index) => <div className="skeleton-row" key={index} />)}
    </div>
  )
}

function SkeletonCards({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, index) => <div className="metric-card skeleton-card" key={index} />)}
    </>
  )
}

function ErrorText({ error }: { error: unknown }) {
  return <p className="error-text">{error instanceof Error ? error.message : 'Something went wrong'}</p>
}

function QueryState({ queries }: { queries: Array<{ isLoading: boolean; error: unknown }> }) {
  const loading = queries.some((query) => query.isLoading)
  const error = queries.find((query) => query.error)?.error
  if (loading) return <div className="empty-state">Loading live data...</div>
  if (error) return <ErrorText error={error} />
  return null
}

function MutationErrors({ mutations }: { mutations: Array<{ error: unknown }> }) {
  const error = mutations.find((mutation) => mutation.error)?.error
  return error ? <ErrorText error={error} /> : null
}

export default App
