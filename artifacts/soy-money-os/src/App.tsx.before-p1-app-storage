import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, Show, SignIn, SignUp, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import {
  Activity as ActivityIcon,
  ArrowRight,
  BarChart3,
  BookOpen,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  Database,
  ExternalLink,
  FileSearch,
  Gauge,
  Layers3,
  LayoutDashboard,
  Menu,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Target,
  TerminalSquare,
  X,
  Zap,
} from 'lucide-react';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation, useParams } from 'wouter';
import {
  getGetDashboardQueryKey,
  getGetOpportunityQueryKey,
  getGetProjectQueryKey,
  getHealthCheckQueryKey,
  getListApprovalsQueryKey,
  getListOpportunitiesQueryKey,
  getListProjectsQueryKey,
  useCreateOpportunity,
  useDecideApproval,
  useGetDashboard,
  useGetOpportunity,
  useGetProject,
  useHealthCheck,
  useListActivity,
  useListApprovals,
  useListDemandProof,
  useListLearning,
  useListOpportunities,
  useListProjects,
  useListResults,
  useStartPipeline,
  useGetCurrentCycle,
  getGetCurrentCycleQueryKey,
  useStartCycle,
  useDecideCycle,
  getGetMoneyLabSummaryQueryKey,
  getListMarketCyclesQueryKey,
  useGetMoneyLabSummary,
  useListMarketCycles,
  useStartMarketCycle,
  useGetAutonomyStatus,
  useListAutonomyCandidates,
  useListHumanActions,
  useGetFinanceSummary,
  getGetControlTowerOverviewQueryKey,
  getGetControlTowerTimelineQueryKey,
  getGetOwnerConfigurationQueryKey,
  useGetOwnerConfiguration,
  useUpdateOwnerConfiguration,
  useReadinessCheck,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import EvidenciaPage from '@/pages/EvidenciaPage';
import NotFound from '@/pages/not-found';
import AutonomiaPage from '@/pages/AutonomiaPage';
import AccionesPage from '@/pages/AccionesPage';
import FinanzasPage from '@/pages/FinanzasPage';
import TorreControlPage from '@/pages/TorreControlPage';
import EjecucionPage from '@/pages/EjecucionPage';
import MoneyLabPage from '@/pages/MoneyLabPage';
import ProyectosPage from '@/pages/ProyectosPage';
import ProyectoDetailPage from '@/pages/ProyectoDetailPage';
import OportunidadDetailPage from '@/pages/OportunidadDetailPage';

const queryClient = new QueryClient();

const navGroups = [
  {
    label: 'Operación',
    items: [
      { href: '/user-portal', label: 'Vista ejecutiva', icon: LayoutDashboard },
      { href: '/torre-control', label: 'Torre de control', icon: Radar },
      { href: '/autonomia', label: 'Motor Autónomo', icon: Sparkles },
      { href: '/acciones', label: 'Cola Humana', icon: ShieldCheck },
      { href: '/finanzas', label: 'Finanzas Reales', icon: Database },
      { href: '/oportunidades', label: 'Oportunidades', icon: Target },
    ],
  },
  {
    label: 'Trazabilidad',
    items: [
      { href: '/evidencia', label: 'Evidencia', icon: ClipboardCheck },
      { href: '/demand-proof', label: 'Prueba de demanda', icon: FileSearch },
      { href: '/proyectos', label: 'Proyectos', icon: Layers3 },
      { href: '/ejecucion', label: 'Ejecución', icon: ActivityIcon },
      { href: '/resultados', label: 'Resultados', icon: BarChart3 },
      { href: '/aprendizaje', label: 'Aprendizaje', icon: BrainCircuit },
      { href: '/money-lab', label: 'Money Lab', icon: Gauge },
    ],
  },
];

export function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export function formatDate(date?: string | null) {
  if (!date) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(date));
}

export function formatTime(date?: string | null) {
  if (!date) return '—';
  return new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(new Date(date));
}

export function statusTone(status?: string) {
  const value = (status || '').toUpperCase();
  if (value.includes('UNVERIFIED') || value === 'PENDING' || value === 'RUNNING' || value === 'IN_PROGRESS' || value === 'PAUSED' || value === 'POTENTIAL') return 'status-amber';
  if (value === 'NOT_VERIFIED' || value === 'NOT VERIFIED') return 'status-red';
  if (value.includes('VERIFIED') || value === 'APPROVED' || value === 'COMPLETED' || value === 'ACTIVE' || value === 'HEALTHY' || value === 'ON' || value === 'REAL') return 'status-green';
  if (value.includes('SEARCH') || value === 'REVIEW' || value === 'QUEUED' || value === 'PAPER') return 'status-blue';
  if (value.includes('SIMULATION') || value === 'TEST') return 'status-violet';
  if (value === 'FAILED' || value === 'REJECTED' || value === 'ERROR' || value === 'OFF') return 'status-red';
  return 'status-neutral';
}

export function statusLabel(status?: string) {
  if (!status) return 'SIN DATOS';
  return status.replaceAll('_', ' ');
}

export function DataState({ loading, error, errorDetail, empty, onRetry, children }: { loading?: boolean; error?: boolean; errorDetail?: string; empty?: boolean; onRetry?: () => void; children: ReactNode }) {
  if (loading) {
    return <div className="space-y-3" data-testid="state-loading"><div className="skeleton h-20 w-full" /><div className="skeleton h-20 w-full" /><div className="skeleton h-20 w-4/5" /></div>;
  }
  if (error) {
    return <div className="empty-state" data-testid="state-error"><CircleAlert size={22} /><strong>No se pudo cargar este registro</strong><span>{errorDetail || 'El origen no respondió. Conservamos la interfaz lista para reintentar.'}</span>{onRetry && <button className="button button-secondary mt-3" onClick={onRetry} data-testid="button-retry">Reintentar</button>}</div>;
  }
  if (empty) {
    return <div className="empty-state" data-testid="state-empty"><Database size={22} /><strong>Sin señales todavía</strong><span>Cuando el sistema encuentre actividad, aparecerá aquí con su trazabilidad completa.</span></div>;
  }
  return <>{children}</>;
}

export function Badge({ value, small = false }: { value?: string; small?: boolean }) {
  return <span className={cx('status-badge', statusTone(value), small && 'text-[10px]')} data-testid={`status-${(value || 'sin-datos').toLowerCase()}`}>{statusLabel(value)}</span>;
}

type ShellProps = {
  children: ReactNode;
  ownerName?: string;
  onSignOut?: () => void | Promise<void>;
};

function Shell({ children, ownerName = 'Propietario', onSignOut }: ShellProps) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const ownerInitials = ownerName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'SO';

  const handleSignOut = async () => {
    await onSignOut?.();
  };
  const pageName = location === '/user-portal' ? 'Vista ejecutiva' : navGroups.flatMap((group) => group.items).find((item) => location.startsWith(item.href) && item.href !== '/')?.label || (location === '/configuracion' ? 'Configuración' : 'SOY MONEY OS');
  return (
    <div className="app-frame paper-noise">
      <aside className={cx('sidebar', mobileOpen && 'sidebar-open')}>
        <div className="brand-block">
          <div className="brand-mark"><span>SM</span><i /></div>
          <div><div className="brand-name">SOY MONEY</div><div className="brand-sub">OPERATING SYSTEM <span>v0.1</span></div></div>
        </div>
        <div className="sidebar-rule" />
        <div className="side-kicker">Centro de control</div>
        <nav className="nav-stack">
          {navGroups.map((group) => <div key={group.label} className="nav-group"><div className="nav-group-label">{group.label}</div>{group.items.map((item) => {
            const Icon = item.icon;
            const active = item.href === '/' ? location === '/' : location.startsWith(item.href);
            return <Link href={item.href} key={item.href} onClick={() => setMobileOpen(false)} className={cx('nav-item', active && 'nav-item-active')} data-testid={`link-nav-${item.label.toLowerCase().replaceAll(' ', '-')}`}><Icon size={16} strokeWidth={active ? 2.4 : 1.8} /><span>{item.label}</span></Link>;
          })}</div>)}
          <div className="nav-group"><div className="nav-group-label">Sistema</div><Link href="/configuracion" onClick={() => setMobileOpen(false)} className={cx('nav-item', location.startsWith('/configuracion') && 'nav-item-active')} data-testid="link-nav-configuracion"><Settings2 size={16} /><span>Configuración</span></Link></div>
        </nav>
        <div className="sidebar-bottom">
          <div className="system-chip"><span className="pulse-signal" /><div><strong>SISTEMA OPERATIVO</strong><small>Servicios supervisados</small></div></div>
          <div className="operator">
            <div className="avatar">{ownerInitials}</div>
            <div className="min-w-0 flex-1">
              <strong className="block truncate">{ownerName}</strong>
              <small>Propietario · sesión activa</small>
            </div>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => void handleSignOut()}
              data-testid="button-sign-out"
            >
              Cerrar sesión
            </button>
          </div>
        </div>
      </aside>
      <div className="main-wrap">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileOpen((open) => !open)} data-testid="button-toggle-menu"><Menu size={21} /></button>
          <div className="breadcrumbs"><span>SOY MONEY OS</span><span className="slash">/</span><strong>{pageName}</strong></div>
          <div className="topbar-actions"><span className="topbar-date">{new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: '2-digit', month: 'short' }).format(new Date())}</span><div className="topbar-pulse"><span className="pulse-dot" /> Live</div></div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="page-header animate-enter"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>;
}

export function MetricCard({ label, value, note, icon: Icon, tone = 'ink' }: { label: string; value: string | number; note: string; icon: any; tone?: string }) {
  return <div className={cx('metric-card animate-enter', `metric-${tone}`)}><div className="metric-top"><span>{label}</span><Icon size={17} /></div><strong data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}>{value}</strong><small>{note}</small></div>;
}

function CycleControl({ onCreated }: { onCreated?: () => void }) {
  const queryClient = useQueryClient();
  const { data: cycle } = useGetCurrentCycle({
    query: {
      queryKey: getGetCurrentCycleQueryKey(),
      refetchInterval: (query) => {
        const state = query.state.data?.state;
        if (state === 'COMPLETED' || state === 'FAILED' || state === 'REJECTED') return false;
        return 3000;
      }
    }
  });

  const startCycle = useStartCycle();
  const decideCycle = useDecideCycle();
  const opportunity = useGetOpportunity(cycle?.opportunityId ?? 0, { query: { enabled: !!cycle?.opportunityId, queryKey: getGetOpportunityQueryKey(cycle?.opportunityId ?? 0) } });
  const projectId = cycle?.projectId ?? 0;
  const project = useGetProject(projectId, { query: { queryKey: getGetProjectQueryKey(projectId), enabled: projectId > 0, refetchInterval: projectId > 0 && cycle?.state !== 'COMPLETED' && cycle?.state !== 'REJECTED' && cycle?.state !== 'FAILED' ? 3000 : false } });
  const approvals = useListApprovals();
  const cycleApproval = approvals.data?.find((item) => item.id === cycle?.approvalId);
  const [query, setQuery] = useState('');

  const isTerminal = cycle?.state === 'COMPLETED' || cycle?.state === 'FAILED' || cycle?.state === 'REJECTED';
  const isActive = cycle && !isTerminal;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim().length < 2) return;
    const idempotencyKey = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
    startCycle.mutate({ data: { query: query.trim(), idempotencyKey } }, {
      onSuccess: () => {
        setQuery('');
        queryClient.invalidateQueries({ queryKey: getGetCurrentCycleQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetControlTowerOverviewQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetControlTowerTimelineQueryKey() });
        onCreated?.();
      }
    });
  };

  const handleDecision = (decision: 'approved' | 'rejected') => {
    if (!cycle?.id) return;
    decideCycle.mutate({ id: cycle.id, data: { decision } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCurrentCycleQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListApprovalsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListOpportunitiesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetControlTowerOverviewQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetControlTowerTimelineQueryKey() });
      }
    });
  };

  const stages = [
    'DISCOVERY', 'RESEARCH', 'EVIDENCE', 'VALIDATION', 'WAITING_APPROVAL',
    'APPROVED', 'BUILD', 'QA', 'SELL_READY', 'RESULT', 'LEARNING', 'COMPLETED'
  ];

  return (
    <div className="launch-panel cycle-panel">
      <div className="launch-intro">
        <div className="launch-icon"><Zap size={20} /></div>
        <div>
          <div className="eyebrow">Motor Autónomo</div>
          <h2>Operación de ciclo completo</h2>
          <p>Describe una tensión de mercado. El motor investigará, pedirá tu decisión y preparará el proyecto sin publicar ni vender.</p>
        </div>
      </div>
      <form onSubmit={submit} className="launch-form">
        <div className="launch-input-wrap">
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ej. software de cobro para clínicas"
            disabled={!!(isActive || startCycle.isPending)}
            data-testid="input-cycle-query"
          />
          <span>⌘ ↵</span>
        </div>
        <button
          type="submit"
          className="button button-primary"
          disabled={!!(startCycle.isPending || query.trim().length < 2 || isActive)}
          data-testid="button-start-cycle"
        >
          {startCycle.isPending ? <RefreshCw size={15} className="spin" /> : <Play size={15} />}
          {startCycle.isPending ? 'Iniciando' : 'INICIAR CICLO'}
        </button>
      </form>

      {cycle && (
        <div className="cycle-active-section animate-enter">
          <div className="eyebrow">CICLO ACTUAL: {cycle.state}</div>

          <div className="cycle-stages">
            {stages.map((s) => {
              const isCurrent = cycle.stage === s && !isTerminal;
              const isDone = stages.indexOf(cycle.stage) > stages.indexOf(s) || isTerminal;
              return (
                <div key={s} className={cx('cycle-stage', isCurrent && 'stage-current', isDone && 'stage-done')}>
                  {s.replaceAll('_', ' ')}
                </div>
              );
            })}
          </div>

          <div className="cycle-meta">
            <div><strong>ID:</strong> CYC-{String(cycle.id).padStart(4, '0')}</div>
            <div><strong>Inicio:</strong> {formatTime(cycle.startedAt)}</div>
            <div><strong>Actualización:</strong> {formatTime(cycle.updatedAt)}</div>
            {cycle.opportunityId && <div><strong>Oportunidad:</strong> #{cycle.opportunityId}</div>}
            {cycle.projectId && <div><strong>Proyecto:</strong> #{cycle.projectId}</div>}
            {cycle.approvalId && <div><strong>Aprobación:</strong> #{cycle.approvalId}</div>}
          </div>

          {(opportunity.data || cycleApproval || project.data) && <div className="cycle-detail">
            {opportunity.data && <div><strong>{opportunity.data.name}</strong><span>{opportunity.data.status} · {opportunity.data.proofStatus} · {opportunity.data.evidence.length} evidencias</span></div>}
            {cycleApproval && <div><strong>Decisión humana: {cycleApproval.status}</strong><span>{cycleApproval.reason}</span></div>}
            {project.data && <div><strong>Proyecto: {project.data.project.status}</strong><span>QA {project.data.project.qaStatus ?? 'pendiente'} · Paquete comercial {project.data.project.sellPackage ? 'preparado' : 'pendiente'} · Resultado {project.data.result?.status ?? 'pendiente'} · Aprendizaje {project.data.learning?.status ?? 'pendiente'}</span></div>}
          </div>}

          {cycle.state === 'COMPLETED' ? (
            <div className="cycle-message" style={{ borderColor: 'hsl(145 43% 41%)', backgroundColor: 'hsl(145 43% 41% / 0.1)' }}>
              Proyecto preparado. No se ha realizado una venta real.
            </div>
          ) : cycle.message ? (
            <div className="cycle-message">
              <strong>{cycle.stage}:</strong> {cycle.message}
            </div>
          ) : null}

          {cycle.error && (
            <div className="cycle-error">
              <strong>Error{cycle.errorService ? ` (${cycle.errorService} ${cycle.errorStatusCode})` : ''}:</strong> {cycle.error}
            </div>
          )}

          {cycle.stage === 'WAITING_APPROVAL' && !isTerminal && (
            <div className="cycle-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => handleDecision('approved')}
                disabled={decideCycle.isPending}
                data-testid="button-approve-cycle"
              >
                {decideCycle.isPending ? 'Procesando...' : <><Check size={14} /> APROBAR</>}
              </button>
              <button
                type="button"
                className="button"
                style={{ backgroundColor: 'hsl(var(--destructive))', color: 'hsl(var(--destructive-foreground))', borderColor: 'transparent' }}
                onClick={() => handleDecision('rejected')}
                disabled={decideCycle.isPending}
                data-testid="button-reject-cycle"
              >
                {decideCycle.isPending ? 'Procesando...' : <><X size={14} /> RECHAZAR</>}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ActivityList({ activities, compact = false }: { activities?: Array<{ id?: number; executionId?: number; stage?: string; status?: string; message?: string; createdAt?: string }>; compact?: boolean }) {
  return <div className={cx('activity-list', compact && 'activity-compact')}>{(activities || []).slice(0, compact ? 5 : 30).map((activity, index) => <div className="activity-row" key={`${activity.id || index}-${activity.createdAt}`} data-testid={`row-activity-${activity.id || index}`}><div className={cx('activity-marker', statusTone(activity.status))}><span /></div><div className="activity-body"><div className="activity-meta"><strong>{activity.stage || 'Sistema'}</strong><span>{formatTime(activity.createdAt)}</span></div><p>{activity.message || 'Actividad registrada'}</p>{!compact && <Badge value={activity.status} small />}</div></div>)}</div>;
}

function DashboardPage() {
  const dashboard = useGetDashboard();
  const approvals = useListApprovals();
  const opportunities = useListOpportunities();

  const autonomy = useGetAutonomyStatus();
  const candidates = useListAutonomyCandidates();
  const humanActions = useListHumanActions();
  const finance = useGetFinanceSummary();

  const queryClient = useQueryClient();
  const d = dashboard.data;
  const recent = d?.recentActivity || [];

  const autonomyStatus = autonomy.data?.status || 'OFF';
  const waitingHuman = (humanActions.data || []).filter(a => a.status === 'PENDING').length;
  const candidatesCount = candidates.data?.length || 0;

  return <div><PageHeader eyebrow="Control ejecutivo / 01" title="El dinero está en las señales." description="Detecta, verifica y decide qué merece convertirse en una operación." action={<Link href="/oportunidades" className="button button-secondary" data-testid="link-see-opportunities">Abrir oportunidades <ArrowRight size={15} /></Link>} />
    <div className="hero-strip animate-enter animate-enter-delay-1"><div><div className="hero-label"><span className="live-bar" style={{ backgroundColor: autonomyStatus === 'ON' ? 'hsl(var(--sidebar-primary))' : 'hsl(var(--destructive))' }} /> {autonomyStatus === 'ON' ? 'MOTOR AUTÓNOMO ACTIVO' : autonomyStatus === 'PAUSED' ? 'MOTOR EN PAUSA' : 'MOTOR APAGADO'}</div><h2>De la hipótesis a la evidencia.<br /><em>Sin atajos.</em></h2></div><div className="hero-aside"><div className="hero-aside-value">{d?.systemStatus ? statusLabel(d.systemStatus) : 'MONITOREANDO'}</div><div>estado del sistema</div><div className="hero-grid-mark"><span /><span /><span /><span /></div></div></div>

    <div className="metric-grid mb-6">
      <MetricCard label="Motor Autónomo" value={autonomyStatus} note={`${candidatesCount} candidatos en cola`} icon={Sparkles} tone={autonomyStatus === 'ON' ? 'lime' : autonomyStatus === 'PAUSED' ? 'amber' : 'coral'} />
      <MetricCard label="Acciones Humanas" value={waitingHuman || '0'} note="requieren intervención" icon={ShieldCheck} tone={waitingHuman > 0 ? 'amber' : 'blue'} />
      <MetricCard label="Dinero Real" value={`$${finance.data?.real?.toFixed(2) || '0.00'}`} note="Eventos marcados como REAL" icon={Database} tone="lime" />
      <MetricCard label="Simulación" value={`$${finance.data?.paper?.toFixed(2) || '0.00'}`} note="Proyección Paper" icon={BarChart3} tone="blue" />
    </div>

    <div className="dashboard-grid"><CycleControl onCreated={() => { queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); queryClient.invalidateQueries({ queryKey: getListOpportunitiesQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetControlTowerOverviewQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetControlTowerTimelineQueryKey() }); }} /><section className="panel activity-panel"><div className="panel-heading"><div><div className="eyebrow">Registro reciente</div><h3>Actividad del sistema</h3></div><Link href="/ejecucion" className="icon-link" data-testid="link-all-activity"><ArrowRight size={17} /></Link></div><DataState loading={dashboard.isLoading} error={!!dashboard.error} empty={!dashboard.isLoading && recent.length === 0} onRetry={() => void dashboard.refetch()}><ActivityList activities={recent} compact /></DataState></section></div>
    <div className="lower-grid"><section className="panel"><div className="panel-heading"><div><div className="eyebrow">Decisión humana</div><h3>Cola de aprobación</h3></div><Link href="/oportunidades" className="text-link" data-testid="link-approval-queue">Revisar cola <ArrowRight size={14} /></Link></div>{(approvals.data || []).slice(0, 3).map((approval) => <ApprovalRow key={approval.id} approval={approval} />)}{!approvals.isLoading && !approvals.data?.length && <div className="inline-empty">No hay checkpoints pendientes.</div>}</section><section className="panel signal-panel"><div className="panel-heading"><div><div className="eyebrow">Inventario de señales</div><h3>Últimas oportunidades</h3></div><Link href="/oportunidades" className="text-link" data-testid="link-opportunity-inventory">Ver inventario <ArrowRight size={14} /></Link></div>{(opportunities.data || []).slice(0, 3).map((opportunity) => <Link href={`/oportunidades/${opportunity.id}`} className="signal-row" key={opportunity.id} data-testid={`link-opportunity-${opportunity.id}`}><div className="signal-score">{opportunity.score}<small>/100</small></div><div><strong>{opportunity.name}</strong><span>{opportunity.sector} · {statusLabel(opportunity.proofStatus)}</span></div><ArrowRight size={15} /></Link>)}{!opportunities.isLoading && !opportunities.data?.length && <div className="inline-empty">La bandeja está lista para nuevas señales.</div>}</section></div>
  </div>;
}

function ApprovalRow({ approval, onDecision }: { approval: { id: number; opportunityId: number; type: string; status: string; reason: string; createdAt: string }; onDecision?: (id: number, decision: 'approved' | 'rejected') => void }) {
  return <div className="approval-row" data-testid={`row-approval-${approval.id}`}><div className="approval-mark"><ClipboardCheck size={15} /></div><div className="approval-copy"><strong>Oportunidad #{approval.opportunityId}</strong><span>{approval.type} · {approval.reason}</span></div><Badge value={approval.status} small />{onDecision && <button className="icon-button" onClick={() => onDecision(approval.id, 'approved')} data-testid={`button-approve-${approval.id}`}><Check size={15} /></button>}</div>;
}

function OpportunityForm({ onClose }: { onClose: () => void }) {
  const create = useCreateOpportunity();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: '', description: '', sector: '', problem: '', targetCustomer: '', proposedSolution: '', monetizationMethod: '' });
  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); if (Object.values(form).some((value) => !value.trim())) return; create.mutate({ data: form }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListOpportunitiesQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetControlTowerOverviewQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetControlTowerTimelineQueryKey() }); onClose(); } }); };
  return <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-opportunity-title"><div className="modal-heading"><div><div className="eyebrow">Registro manual</div><h2 id="new-opportunity-title">Nueva oportunidad</h2></div><button className="icon-button" onClick={onClose} data-testid="button-close-opportunity-form"><X size={18} /></button></div><form onSubmit={submit} className="form-grid"><Field label="Nombre" value={form.name} onChange={(v) => update('name', v)} placeholder="Nombre operativo" testId="input-opportunity-name" /><Field label="Sector" value={form.sector} onChange={(v) => update('sector', v)} placeholder="Ej. Salud, fintech, logística" testId="input-opportunity-sector" /><Field label="Descripción" value={form.description} onChange={(v) => update('description', v)} placeholder="Qué hemos detectado" wide testId="input-opportunity-description" /><Field label="Problema" value={form.problem} onChange={(v) => update('problem', v)} placeholder="La fricción concreta" wide testId="input-opportunity-problem" /><Field label="Cliente objetivo" value={form.targetCustomer} onChange={(v) => update('targetCustomer', v)} placeholder="Quién paga o sufre" testId="input-opportunity-customer" /><Field label="Solución propuesta" value={form.proposedSolution} onChange={(v) => update('proposedSolution', v)} placeholder="Qué se construiría" testId="input-opportunity-solution" /><Field label="Monetización" value={form.monetizationMethod} onChange={(v) => update('monetizationMethod', v)} placeholder="Cómo se captura valor" wide testId="input-opportunity-monetization" /><div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose} data-testid="button-cancel-opportunity">Cancelar</button><button type="submit" className="button button-primary" disabled={create.isPending || Object.values(form).some((value) => !value.trim())} data-testid="button-save-opportunity">{create.isPending ? 'Guardando…' : 'Registrar oportunidad'}</button></div></form></div></div>;
}

function Field({ label, value, onChange, placeholder, wide, testId }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; wide?: boolean; testId: string }) {
  return <label className={cx('field', wide && 'field-wide')}><span>{label}</span>{wide ? <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={3} data-testid={testId} /> : <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} data-testid={testId} />}</label>;
}

function OpportunitiesPage() {
  const opportunities = useListOpportunities();
  const [formOpen, setFormOpen] = useState(false);
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => (opportunities.data || []).filter((opportunity) => `${opportunity.name} ${opportunity.sector} ${opportunity.problem}`.toLowerCase().includes(search.toLowerCase())), [opportunities.data, search]);
  return <div><PageHeader eyebrow="Inventario / 02" title="Oportunidades" description="Cada señal tiene una procedencia, una hipótesis y un siguiente checkpoint." action={<button className="button button-primary" onClick={() => setFormOpen(true)} data-testid="button-new-opportunity"><Plus size={16} /> Registrar señal</button>} /><div className="toolbar"><div className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nombre, sector o problema" data-testid="input-search-opportunities" /></div><button className="button button-quiet" onClick={() => setSearch('')} data-testid="button-filter-opportunities"><SlidersHorizontal size={15} /> Limpiar filtros <span className="filter-count">0</span></button></div><DataState loading={opportunities.isLoading} error={!!opportunities.error} empty={!opportunities.isLoading && filtered.length === 0} onRetry={() => void opportunities.refetch()}><div className="opportunity-list">{filtered.map((opportunity) => <OpportunityCard key={opportunity.id} opportunity={opportunity} />)}</div></DataState>{formOpen && <OpportunityForm onClose={() => setFormOpen(false)} />}</div>;
}

function OpportunityCard({ opportunity }: { opportunity: { id: number; name: string; description: string; sector: string; problem: string; targetCustomer: string; score: number; estimatedCost: number; difficulty: string; risk: string; timeToRevenue: string; status: string; proofStatus: string; updatedAt: string } }) {
  return <Link href={`/oportunidades/${opportunity.id}`} className="opportunity-card" data-testid={`card-opportunity-${opportunity.id}`}><div className="opportunity-top"><span className="record-id">OP-{String(opportunity.id).padStart(4, '0')}</span><Badge value={opportunity.proofStatus} small /><span className="card-date">{formatDate(opportunity.updatedAt)}</span></div><div className="opportunity-main"><div className="score-block"><strong>{opportunity.score}</strong><span>score</span></div><div className="opportunity-copy"><h3>{opportunity.name}</h3><p>{opportunity.description}</p><div className="opportunity-tags"><span>{opportunity.sector}</span><span>{opportunity.difficulty}</span><span>{opportunity.timeToRevenue}</span></div></div><ArrowRight className="card-arrow" size={18} /></div><div className="opportunity-bottom"><span><b>Problema</b>{opportunity.problem}</span><span><b>Cliente</b>{opportunity.targetCustomer}</span><span><b>Riesgo</b>{opportunity.risk}</span><span><b>Estado</b><Badge value={opportunity.status} small /></span></div></Link>;
}

function DemandProofPage() {
  const proof = useListDemandProof();
  const opportunities = useListOpportunities();
  const names = useMemo(() => new Map((opportunities.data || []).map((opportunity) => [opportunity.id, opportunity.name])), [opportunities.data]);
  return <div><PageHeader eyebrow="Validación / 03" title="Prueba de demanda" description="No confundas una búsqueda con una señal. Aquí se separa lo observado de lo que aún necesita prueba." action={<div className="legend"><Badge value="REAL_VERIFIED" small /><Badge value="REAL_UNVERIFIED" small /><Badge value="SEARCH_EVIDENCE" small /><Badge value="TEST_SIMULATION" small /></div>} /><div className="proof-banner"><div className="proof-banner-icon"><ShieldCheck size={20} /></div><div><strong>Taxonomía de evidencia activa</strong><p>Los estados no son decoración: determinan cuánto puede avanzar una oportunidad sin intervención humana.</p></div><div className="proof-count">{proof.data?.length || 0}<small>registros</small></div></div><DataState loading={proof.isLoading} error={!!proof.error} empty={!proof.isLoading && !proof.data?.length} onRetry={() => void proof.refetch()}><div className="table-card"><div className="table-head"><span>Oportunidad</span><span>Tipo de prueba</span><span>Resumen</span><span>Estado</span><span>Fecha</span></div>{(proof.data || []).map((item) => <div className="table-row" key={item.id} data-testid={`row-demand-proof-${item.id}`}><div className="table-title"><span className="mini-id">DP-{String(item.id).padStart(3, '0')}</span><strong>{names.get(item.opportunityId) || `Oportunidad #${item.opportunityId}`}</strong></div><span>{item.proofType}</span><span className="table-summary">{item.summary}</span><Badge value={item.status} small /><span className="muted-text">{formatDate(item.createdAt)}</span></div>)}</div></DataState></div>;
}

function ResultsPage() {
  const results = useListResults();
  const projects = useListProjects();
  const names = useMemo(() => new Map((projects.data || []).map((project) => [project.id, project.name])), [projects.data]);
  return <div><PageHeader eyebrow="Retorno / 06" title="Resultados" description="Lo que ocurrió después de la hipótesis. El aprendizaje empieza cuando medimos el resultado." /><DataState loading={results.isLoading} error={!!results.error} empty={!results.isLoading && !results.data?.length} onRetry={() => void results.refetch()}><div className="results-list">{(results.data || []).map((result) => <div className="result-row" key={result.id} data-testid={`row-result-${result.id}`}><div className="result-status"><BarChart3 size={17} /></div><div className="result-main"><div><span className="record-id">RES-{String(result.id).padStart(3, '0')}</span><Badge value={result.status} small /></div><h3>{result.outcome}</h3><span>Proyecto: {names.get(result.projectId) || `#${result.projectId}`}</span></div><time>{formatDate(result.createdAt)}</time><ArrowRight size={16} /></div>)}</div></DataState></div>;
}

function LearningPage() {
  const learning = useListLearning();
  return <div><PageHeader eyebrow="Memoria del sistema / 07" title="Aprendizaje" description="Patrones que la operación devuelve al sistema para que la próxima decisión sea más precisa." action={<div className="header-stamp"><BookOpen size={15} /> Base de conocimiento</div>} /><DataState loading={learning.isLoading} error={!!learning.error} empty={!learning.isLoading && !learning.data?.length} onRetry={() => void learning.refetch()}><div className="insight-grid">{(learning.data || []).map((insight) => <article className="insight-card" key={insight.id} data-testid={`card-insight-${insight.id}`}><div className="insight-top"><span className="insight-index">0{insight.id}</span><Badge value={insight.status} small /></div><Sparkles size={19} className="insight-icon" /><h3>{insight.title}</h3><p>{insight.summary}</p><div className="insight-date">{formatDate(insight.createdAt)} <ArrowRight size={13} /></div></article>)}</div></DataState></div>;
}

function ApprovalsPanel() {
  const approvals = useListApprovals();
  const decide = useDecideApproval();
  const queryClient = useQueryClient();
  const decision = (id: number, value: 'approved' | 'rejected') => decide.mutate({ id, data: { decision: value } }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListApprovalsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetControlTowerOverviewQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetControlTowerTimelineQueryKey() }); } });
  return <div className="settings-approvals"><div className="panel-heading"><div><div className="eyebrow">Gobernanza</div><h3>Decisiones pendientes</h3></div><Badge value="PENDING" /></div><DataState loading={approvals.isLoading} error={!!approvals.error} empty={!approvals.isLoading && !approvals.data?.length} onRetry={() => void approvals.refetch()}>{(approvals.data || []).map((approval) => <div className="approval-detail" key={approval.id} data-testid={`card-setting-approval-${approval.id}`}><div><strong>Checkpoint {approval.type}</strong><p>{approval.reason}</p><span>Creado {formatDate(approval.createdAt)}</span></div><div className="approval-actions"><button className="button button-secondary button-small" onClick={() => decision(approval.id, 'rejected')} disabled={decide.isPending} data-testid={`button-reject-${approval.id}`}><X size={14} /> Rechazar</button><button className="button button-primary button-small" onClick={() => decision(approval.id, 'approved')} disabled={decide.isPending} data-testid={`button-approve-setting-${approval.id}`}><Check size={14} /> Aprobar</button></div></div>)}</DataState></div>;
}

function SettingsPage() {
  const health = useHealthCheck({
    query: { queryKey: getHealthCheckQueryKey() },
  });

  const readiness = useReadinessCheck();

  const configuration = useGetOwnerConfiguration({
    query: { queryKey: getGetOwnerConfigurationQueryKey() },
  });

  const updateConfiguration = useUpdateOwnerConfiguration();
  const queryClient = useQueryClient();

  const config = configuration.data;
  const integrations = Object.entries(config?.integrationStatuses ?? {});

  const updateIntegration = (
    name: string,
    status: 'NOT_CONFIGURED' | 'AVAILABLE' | 'DEGRADED' | 'DISABLED',
  ) => {
    if (!config) return;

    updateConfiguration.mutate(
      {
        data: {
          integrationStatuses: {
            ...config.integrationStatuses,
            [name]: status,
          },
        },
      },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: getGetOwnerConfigurationQueryKey(),
          });
        },
      },
    );
  };

  return (
    <div>
      <PageHeader
        eyebrow="Sistema / 08"
        title="Configuración"
        description="Configuración persistida, integraciones y límites operativos del sistema."
        action={
          <button
            className="button button-secondary"
            onClick={() => {
              void configuration.refetch();
              void health.refetch();
              void readiness.refetch();
            }}
            data-testid="button-refresh-settings"
          >
            <RefreshCw size={15} />
            Actualizar
          </button>
        }
      />

      <DataState
        loading={configuration.isLoading}
        error={!!configuration.error}
        empty={!configuration.isLoading && !config}
        onRetry={() => void configuration.refetch()}
      >
        {config && (
          <div className="settings-layout">
            <section className="panel integrations">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">Dependencias externas</div>
                  <h3>Integraciones</h3>
                </div>
                <Badge
                  value={
                    integrations.some(([, status]) => status === 'DEGRADED')
                      ? 'DEGRADED'
                      : integrations.some(([, status]) => status === 'AVAILABLE')
                        ? 'AVAILABLE'
                        : 'NOT_CONFIGURED'
                  }
                  small
                />
              </div>

              <p className="section-intro">
                Estados persistidos por el backend. Los secretos y credenciales
                nunca se muestran en esta pantalla.
              </p>

              {integrations.length === 0 ? (
                <div className="inline-empty">
                  No hay integraciones registradas.
                </div>
              ) : (
                integrations.map(([name, status], index) => (
                  <div
                    className="integration-row"
                    key={name}
                    data-testid={`row-integration-${index}`}
                  >
                    <div className="integration-symbol">
                      <Database size={16} />
                    </div>

                    <div>
                      <strong>{name.replaceAll('_', ' ')}</strong>
                      <span>Estado operativo persistido</span>
                    </div>

                    <Badge value={status} small />

                    <select
                      value={status}
                      disabled={updateConfiguration.isPending}
                      onChange={(event) =>
                        updateIntegration(
                          name,
                          event.target.value as
                            | 'NOT_CONFIGURED'
                            | 'AVAILABLE'
                            | 'DEGRADED'
                            | 'DISABLED',
                        )
                      }
                      data-testid={`select-integration-${index}`}
                    >
                      <option value="NOT_CONFIGURED">NOT CONFIGURED</option>
                      <option value="AVAILABLE">AVAILABLE</option>
                      <option value="DEGRADED">DEGRADED</option>
                      <option value="DISABLED">DISABLED</option>
                    </select>
                  </div>
                ))
              )}
            </section>

            <aside className="settings-side">
              <div className="panel system-health">
                <div className="eyebrow">Estado operativo</div>

                <div className="policy-row">
                  <ActivityIcon size={16} />
                  <span>API Health</span>
                  <strong data-testid="status-api-health">
                    {health.data?.status
                      ? statusLabel(health.data.status)
                      : health.isLoading
                        ? 'CONSULTANDO'
                        : 'NO DISPONIBLE'}
                  </strong>
                </div>

                <div className="policy-row">
                  <ShieldCheck size={16} />
                  <span>Readiness</span>
                  <strong data-testid="status-readiness">
                    {readiness.data?.status
                      ? statusLabel(readiness.data.status)
                      : readiness.isLoading
                        ? 'CONSULTANDO'
                        : 'NO DISPONIBLE'}
                  </strong>
                </div>

                {Object.entries(readiness.data?.checks ?? {}).map(
                  ([name, check]) => (
                    <div
                      className="policy-row"
                      key={name}
                      data-testid={`readiness-check-${name}`}
                    >
                      <Database size={16} />
                      <span>
                        {name.replaceAll('_', ' ')}
                        {check.diagnostic && (
                          <small className="block text-muted-foreground">
                            {check.diagnostic}
                          </small>
                        )}
                      </span>
                      <strong>{statusLabel(check.status)}</strong>
                    </div>
                  ),
                )}

                {readiness.error && (
                  <p data-testid="readiness-error">
                    Readiness no disponible. El servicio puede estar respondiendo
                    aunque alguna dependencia operativa no pueda verificarse.
                  </p>
                )}

                <button
                  className="text-link"
                  onClick={() => {
                    void health.refetch();
                    void readiness.refetch();
                  }}
                  data-testid="button-refresh-health"
                >
                  <RefreshCw size={13} />
                  Actualizar estado
                </button>
              </div>

              <div className="panel">
                <div className="eyebrow">Gobernanza real</div>

                <div className="policy-row">
                  <ShieldCheck size={16} />
                  <span>Autonomía</span>
                  <strong>{config.autonomyEnabled ? 'ON' : 'OFF'}</strong>
                </div>

                <div className="policy-row">
                  <ShieldCheck size={16} />
                  <span>Bloqueo autónomo</span>
                  <strong>
                    {config.autonomyExecutionLocked ? 'LOCKED' : 'OFF'}
                  </strong>
                </div>

                <div className="policy-row">
                  <Database size={16} />
                  <span>Finanzas</span>
                  <strong>{config.financeMode}</strong>
                </div>

                <div className="policy-row">
                  <ShieldCheck size={16} />
                  <span>APIs externas</span>
                  <strong>{config.externalApisAllowed ? 'ON' : 'OFF'}</strong>
                </div>

                <div className="policy-row">
                  <ShieldCheck size={16} />
                  <span>Publicación</span>
                  <strong>{config.publishingAllowed ? 'ON' : 'OFF'}</strong>
                </div>

                <div className="policy-row">
                  <ShieldCheck size={16} />
                  <span>Pagos</span>
                  <strong>{config.paymentsAllowed ? 'ON' : 'OFF'}</strong>
                </div>

                <div className="policy-row">
                  <TerminalSquare size={16} />
                  <span>Windmill</span>
                  <strong>
                    {config.windmillLegacyUnused ? 'LEGACY_UNUSED' : 'ACTIVE'}
                  </strong>
                </div>
              </div>
            </aside>
          </div>
        )}
      </DataState>

      {updateConfiguration.isError && (
        <div className="cycle-error" data-testid="settings-save-error">
          No se pudo persistir el cambio de configuración.
        </div>
      )}

      <ApprovalsPanel />
    </div>
  );
}

function ExistingAppRouter({ ownerName, onSignOut }: { ownerName?: string; onSignOut?: () => void | Promise<void> }) {
  return <Shell ownerName={ownerName} onSignOut={onSignOut}><ErrorBoundary resetKey={window.location.pathname}><Switch><Route path="/user-portal" component={DashboardPage} /><Route path="/torre-control" component={TorreControlPage} /><Route path="/oportunidades" component={OpportunitiesPage} /><Route path="/oportunidades/:id" component={OportunidadDetailPage} /><Route path="/evidencia" component={EvidenciaPage} /><Route path="/demand-proof" component={DemandProofPage} /><Route path="/proyectos" component={ProyectosPage} /><Route path="/proyectos/:id" component={ProyectoDetailPage} /><Route path="/ejecucion" component={EjecucionPage} /><Route path="/resultados" component={ResultsPage} /><Route path="/aprendizaje" component={LearningPage} /><Route path="/money-lab" component={MoneyLabPage} /><Route path="/autonomia" component={AutonomiaPage} /><Route path="/acciones" component={AccionesPage} /><Route path="/finanzas" component={FinanzasPage} /><Route path="/configuracion" component={SettingsPage} /><Route component={NotFound} /></Switch></ErrorBoundary></Shell>;
}

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
// This branch is intentionally unavailable in normal Vite modes. Playwright
// starts Vite with --mode e2e and must opt in with the second explicit flag.
const e2eFixtureMode =
  import.meta.env.DEV &&
  !import.meta.env.PROD &&
  import.meta.env.MODE === 'e2e' &&
  import.meta.env.VITE_E2E === 'true' &&
  import.meta.env.VITE_E2E_FIXTURES === 'true';

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || '/'
    : path;
}

if (!e2eFixtureMode && !clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#c7ed45',
    colorForeground: '#152b31',
    colorMutedForeground: '#60747a',
    colorDanger: '#b7473e',
    colorBackground: '#f7f7f1',
    colorInput: '#ffffff',
    colorInputForeground: '#152b31',
    colorNeutral: '#c7d1cc',
    fontFamily: 'DM Sans, sans-serif',
    borderRadius: '0.5rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#f7f7f1] rounded-2xl w-[440px] max-w-full overflow-hidden',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#152b31]',
    headerSubtitle: 'text-[#60747a]',
    socialButtonsBlockButtonText: 'text-[#152b31]',
    formFieldLabel: 'text-[#152b31]',
    footerActionLink: 'text-[#356875]',
    footerActionText: 'text-[#60747a]',
    dividerText: 'text-[#60747a]',
    identityPreviewEditButton: 'text-[#356875]',
    formFieldSuccessText: 'text-[#356875]',
    alertText: 'text-[#b7473e]',
    logoBox: 'rounded-lg overflow-hidden',
    logoImage: 'rounded-lg',
    socialButtonsBlockButton: 'border-[#c7d1cc] bg-white',
    formButtonPrimary: 'bg-[#152b31] text-[#f7f7f1] hover:bg-[#284a53]',
    formFieldInput: 'border-[#c7d1cc] bg-white text-[#152b31]',
    footerAction: 'bg-transparent',
    dividerLine: 'bg-[#c7d1cc]',
    alert: 'bg-[#fff0ed] border-[#e6b8b2]',
    otpCodeFieldInput: 'border-[#c7d1cc] bg-white text-[#152b31]',
    formFieldRow: 'text-[#152b31]',
    main: 'bg-[#f7f7f1]',
  },
};

function SignInPage() {
  return <><Show when="signed-in"><Redirect to="/user-portal" /></Show><Show when="signed-out"><div className="flex min-h-[100dvh] items-center justify-center bg-background px-4"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div></Show></>;
}

function SignUpPage() {
  return <><Show when="signed-in"><Redirect to="/user-portal" /></Show><Show when="signed-out"><div className="flex min-h-[100dvh] items-center justify-center bg-background px-4"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div></Show></>;
}

function HomePage() {
  const [, setLocation] = useLocation();
  return <div className="app-frame paper-noise"><main className="mx-auto flex min-h-[100dvh] w-full max-w-5xl items-center justify-center px-6 py-16"><section className="panel w-full max-w-2xl p-8 md:p-12"><div className="brand-block !px-0"><div className="brand-mark"><span>SM</span><i /></div><div><div className="brand-name">SOY MONEY</div><div className="brand-sub">OPERATING SYSTEM <span>v0.1</span></div></div></div><div className="eyebrow mt-12">Inteligencia operativa</div><h1 className="mt-3">El dinero está en las señales.</h1><p className="mt-5 max-w-xl text-muted-foreground">Detecta, verifica y decide qué merece convertirse en una operación.</p><div className="mt-8 flex flex-wrap gap-3"><button className="button button-primary" onClick={() => setLocation('/sign-in')} data-testid="button-sign-in">Iniciar sesión</button><button className="button button-secondary" onClick={() => setLocation('/sign-up')} data-testid="button-sign-up">Crear cuenta</button></div></section></main></div>;
}

function HomeRedirect() {
  return <><Show when="signed-in"><Redirect to="/user-portal" /></Show><Show when="signed-out"><HomePage /></Show></>;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  const previousUserId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (previousUserId.current !== undefined && previousUserId.current !== userId) client.clear();
      previousUserId.current = userId;
    });
    return unsubscribe;
  }, [addListener, client]);
  return null;
}

function ClerkSignedInApp() {
  const clerk = useClerk();
  const ownerName =
    clerk.user?.fullName ||
    clerk.user?.primaryEmailAddress?.emailAddress ||
    'Propietario';

  return <ExistingAppRouter ownerName={ownerName} onSignOut={() => clerk.signOut()} />;
}

function SignedInRoutes() {
  return <><Show when="signed-in"><ClerkSignedInApp /></Show><Show when="signed-out"><Redirect to="/" /></Show></>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={{ signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to access SOY MONEY OS' } }, signUp: { start: { title: 'Create your account', subtitle: 'Get started with SOY MONEY OS' } } }} routerPush={(to) => setLocation(stripBase(to))} routerReplace={(to) => setLocation(stripBase(to), { replace: true })}><QueryClientProvider client={queryClient}><ClerkQueryClientCacheInvalidator /><Switch><Route path="/" component={HomeRedirect} /><Route path="/sign-in/*?" component={SignInPage} /><Route path="/sign-up/*?" component={SignUpPage} /><Route component={SignedInRoutes} /></Switch><TooltipProvider><Toaster /></TooltipProvider></QueryClientProvider></ClerkProvider>;
}

function E2EFixtureSignIn({ onSignIn, signUp = false }: { onSignIn: () => void; signUp?: boolean }) {
  return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4"><section className="panel w-full max-w-md p-8"><div className="eyebrow">E2E fixture · sin Clerk</div><h1 className="mt-3">{signUp ? 'Crear cuenta' : 'Iniciar sesión'}</h1><p className="mt-4 text-muted-foreground">Identidad determinista para pruebas de navegador. No usa credenciales humanas ni servicios externos.</p><button className="button button-primary mt-8 w-full" onClick={onSignIn} data-testid="button-e2e-sign-in">{signUp ? 'Crear cuenta de prueba' : 'Entrar como propietario de prueba'}</button></section></div>;
}

function E2EFixtureRoutes() {
  const [signedIn, setSignedIn] = useState(() => window.sessionStorage.getItem('soy-money-e2e-auth') === 'signed-in');
  const signIn = () => {
    window.sessionStorage.setItem('soy-money-e2e-auth', 'signed-in');
    setSignedIn(true);
  };
  const signOut = () => {
    window.sessionStorage.removeItem('soy-money-e2e-auth');
    setSignedIn(false);
  };
  return <QueryClientProvider client={queryClient}><Switch><Route path="/" component={() => signedIn ? <Redirect to="/user-portal" /> : <HomePage />} /><Route path="/sign-in/*?" component={() => signedIn ? <Redirect to="/user-portal" /> : <E2EFixtureSignIn onSignIn={signIn} />} /><Route path="/sign-up/*?" component={() => signedIn ? <Redirect to="/user-portal" /> : <E2EFixtureSignIn onSignIn={signIn} signUp />} /><Route component={() => signedIn ? <ExistingAppRouter ownerName="Propietario E2E" onSignOut={signOut} /> : <Redirect to="/" />} /></Switch><button type="button" className="sr-only" onClick={signOut} data-testid="button-e2e-sign-out">Sign out fixture</button><TooltipProvider><Toaster /></TooltipProvider></QueryClientProvider>;
}

function App() {
  return <WouterRouter base={basePath}>{e2eFixtureMode ? <E2EFixtureRoutes /> : <ClerkProviderWithRoutes />}</WouterRouter>;
}

export default App;
