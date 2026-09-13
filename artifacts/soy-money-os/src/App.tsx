import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
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
import { Link, Route, Switch, useLocation, useParams } from 'wouter';
import {
  getGetDashboardQueryKey,
  getGetOpportunityQueryKey,
  getHealthCheckQueryKey,
  getListApprovalsQueryKey,
  getListOpportunitiesQueryKey,
  useCreateOpportunity,
  useDecideApproval,
  useGetDashboard,
  useGetOpportunity,
  useHealthCheck,
  useListActivity,
  useListApprovals,
  useListDemandProof,
  useListLearning,
  useListOpportunities,
  useListProjects,
  useListResults,
  useStartPipeline,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();

const navGroups = [
  {
    label: 'Operación',
    items: [
      { href: '/', label: 'Vista ejecutiva', icon: LayoutDashboard },
      { href: '/oportunidades', label: 'Oportunidades', icon: Radar },
      { href: '/demand-proof', label: 'Prueba de demanda', icon: Target },
    ],
  },
  {
    label: 'Trazabilidad',
    items: [
      { href: '/proyectos', label: 'Proyectos', icon: Layers3 },
      { href: '/ejecucion', label: 'Ejecución', icon: ActivityIcon },
      { href: '/resultados', label: 'Resultados', icon: BarChart3 },
      { href: '/aprendizaje', label: 'Aprendizaje', icon: BrainCircuit },
    ],
  },
];

function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function formatDate(date?: string | null) {
  if (!date) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(date));
}

function formatTime(date?: string | null) {
  if (!date) return '—';
  return new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(new Date(date));
}

function statusTone(status?: string) {
  const value = (status || '').toUpperCase();
  if (value.includes('VERIFIED') || value === 'APPROVED' || value === 'COMPLETED' || value === 'ACTIVE' || value === 'HEALTHY') return 'status-green';
  if (value.includes('UNVERIFIED') || value === 'PENDING' || value === 'RUNNING' || value === 'IN_PROGRESS') return 'status-amber';
  if (value.includes('SEARCH') || value === 'REVIEW' || value === 'QUEUED') return 'status-blue';
  if (value.includes('SIMULATION') || value === 'TEST') return 'status-violet';
  if (value === 'FAILED' || value === 'REJECTED' || value === 'ERROR') return 'status-red';
  return 'status-neutral';
}

function statusLabel(status?: string) {
  if (!status) return 'SIN DATOS';
  return status.replaceAll('_', ' ');
}

function DataState({ loading, error, empty, onRetry, children }: { loading?: boolean; error?: boolean; empty?: boolean; onRetry?: () => void; children: ReactNode }) {
  if (loading) {
    return <div className="space-y-3" data-testid="state-loading"><div className="skeleton h-20 w-full" /><div className="skeleton h-20 w-full" /><div className="skeleton h-20 w-4/5" /></div>;
  }
  if (error) {
    return <div className="empty-state" data-testid="state-error"><CircleAlert size={22} /><strong>No se pudo cargar este registro</strong><span>El origen no respondió. Conservamos la interfaz lista para reintentar.</span>{onRetry && <button className="button button-secondary mt-3" onClick={onRetry} data-testid="button-retry">Reintentar</button>}</div>;
  }
  if (empty) {
    return <div className="empty-state" data-testid="state-empty"><Database size={22} /><strong>Sin señales todavía</strong><span>Cuando el sistema encuentre actividad, aparecerá aquí con su trazabilidad completa.</span></div>;
  }
  return <>{children}</>;
}

function Badge({ value, small = false }: { value?: string; small?: boolean }) {
  return <span className={cx('status-badge', statusTone(value), small && 'text-[10px]')} data-testid={`status-${(value || 'sin-datos').toLowerCase()}`}>{statusLabel(value)}</span>;
}

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const pageName = location === '/' ? 'Vista ejecutiva' : navGroups.flatMap((group) => group.items).find((item) => location.startsWith(item.href) && item.href !== '/')?.label || (location === '/configuracion' ? 'Configuración' : 'SOY MONEY OS');
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
            return <Link href={item.href} key={item.href} onClick={() => setMobileOpen(false)} className={cx('nav-item', active && 'nav-item-active')} data-testid={`link-nav-${item.label.toLowerCase().replaceAll(' ', '-')}`}><Icon size={16} strokeWidth={active ? 2.4 : 1.8} /><span>{item.label}</span>{item.href === '/oportunidades' && <span className="nav-count">04</span>}</Link>;
          })}</div>)}
          <div className="nav-group"><div className="nav-group-label">Sistema</div><Link href="/configuracion" onClick={() => setMobileOpen(false)} className={cx('nav-item', location.startsWith('/configuracion') && 'nav-item-active')} data-testid="link-nav-configuracion"><Settings2 size={16} /><span>Configuración</span></Link></div>
        </nav>
        <div className="sidebar-bottom">
          <div className="system-chip"><span className="pulse-signal" /><div><strong>SISTEMA OPERATIVO</strong><small>Todos los servicios en línea</small></div></div>
          <div className="operator"><div className="avatar">AM</div><div><strong>Analista principal</strong><small>Control de oportunidades</small></div><ChevronDown size={14} /></div>
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

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="page-header animate-enter"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>;
}

function MetricCard({ label, value, note, icon: Icon, tone = 'ink' }: { label: string; value: string | number; note: string; icon: typeof Gauge; tone?: string }) {
  return <div className={cx('metric-card animate-enter', `metric-${tone}`)}><div className="metric-top"><span>{label}</span><Icon size={17} /></div><strong data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}>{value}</strong><small>{note}</small></div>;
}

function PipelineLaunch({ onCreated }: { onCreated?: () => void }) {
  const [query, setQuery] = useState('');
  const startPipeline = useStartPipeline();
  const [result, setResult] = useState<{ name?: string; executionId?: number } | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim().length < 2) return;
    startPipeline.mutate({ data: { query: query.trim() } }, { onSuccess: (run) => { setResult({ name: run.opportunity?.name, executionId: run.executionId }); setQuery(''); onCreated?.(); } });
  };
  return <div className="launch-panel"><div className="launch-intro"><div className="launch-icon"><Zap size={20} /></div><div><div className="eyebrow">Nuevo proceso</div><h2>Arranca una investigación</h2><p>Describe una tensión de mercado. El motor la convertirá en una oportunidad trazable.</p></div></div><form onSubmit={submit} className="launch-form"><div className="launch-input-wrap"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ej. software de cobro para clínicas pequeñas" data-testid="input-pipeline-query" /><span>⌘ ↵</span></div><button type="submit" className="button button-primary" disabled={startPipeline.isPending || query.trim().length < 2} data-testid="button-start-pipeline">{startPipeline.isPending ? <RefreshCw size={15} className="spin" /> : <Play size={15} />}{startPipeline.isPending ? 'Procesando' : 'Iniciar pipeline'}</button></form>{result && <div className="launch-result" data-testid="status-pipeline-success"><CheckCircle2 size={16} /><span>Pipeline #{result.executionId} creado{result.name ? ` · ${result.name}` : ''}</span><Link href="/ejecucion">Ver ejecución <ArrowRight size={14} /></Link></div>}</div>;
}

function ActivityList({ activities, compact = false }: { activities?: Array<{ id?: number; executionId?: number; stage?: string; status?: string; message?: string; createdAt?: string }>; compact?: boolean }) {
  return <div className={cx('activity-list', compact && 'activity-compact')}>{(activities || []).slice(0, compact ? 5 : 30).map((activity, index) => <div className="activity-row" key={`${activity.id || index}-${activity.createdAt}`} data-testid={`row-activity-${activity.id || index}`}><div className={cx('activity-marker', statusTone(activity.status))}><span /></div><div className="activity-body"><div className="activity-meta"><strong>{activity.stage || 'Sistema'}</strong><span>{formatTime(activity.createdAt)}</span></div><p>{activity.message || 'Actividad registrada'}</p>{!compact && <Badge value={activity.status} small />}</div></div>)}</div>;
}

function DashboardPage() {
  const dashboard = useGetDashboard();
  const approvals = useListApprovals();
  const opportunities = useListOpportunities();
  const queryClient = useQueryClient();
  const d = dashboard.data;
  const recent = d?.recentActivity || [];
  return <div><PageHeader eyebrow="Control ejecutivo / 01" title="El dinero está en las señales." description="Detecta, verifica y decide qué merece convertirse en una operación." action={<Link href="/oportunidades" className="button button-secondary" data-testid="link-see-opportunities">Abrir oportunidades <ArrowRight size={15} /></Link>} />
    <div className="hero-strip animate-enter animate-enter-delay-1"><div><div className="hero-label"><span className="live-bar" /> MOTOR DE INTELIGENCIA ACTIVO</div><h2>De la hipótesis a la evidencia.<br /><em>Sin atajos.</em></h2></div><div className="hero-aside"><div className="hero-aside-value">{d?.systemStatus ? statusLabel(d.systemStatus) : 'MONITOREANDO'}</div><div>estado del sistema</div><div className="hero-grid-mark"><span /><span /><span /><span /></div></div></div>
    <div className="metric-grid"><MetricCard label="Señales encontradas" value={d?.opportunitiesFound ?? '—'} note="en el universo explorado" icon={Radar} tone="lime" /><MetricCard label="Verificadas" value={d?.opportunitiesVerified ?? '—'} note="listas para decisión humana" icon={ShieldCheck} tone="blue" /><MetricCard label="Procesos activos" value={d?.activeProcesses ?? '—'} note={`${d?.failedProcesses ?? 0} fallidos en el periodo`} icon={ActivityIcon} tone="amber" /><MetricCard label="Aprobaciones" value={d?.pendingApprovals ?? approvals.data?.length ?? '—'} note="requieren criterio humano" icon={ClipboardCheck} tone="coral" /></div>
    <div className="dashboard-grid"><PipelineLaunch onCreated={() => { queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); queryClient.invalidateQueries({ queryKey: getListOpportunitiesQueryKey() }); }} /><section className="panel activity-panel"><div className="panel-heading"><div><div className="eyebrow">Registro reciente</div><h3>Actividad del sistema</h3></div><Link href="/ejecucion" className="icon-link" data-testid="link-all-activity"><ArrowRight size={17} /></Link></div><DataState loading={dashboard.isLoading} error={!!dashboard.error} empty={!dashboard.isLoading && recent.length === 0} onRetry={() => void dashboard.refetch()}><ActivityList activities={recent} compact /></DataState></section></div>
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
  const submit = (event: FormEvent) => { event.preventDefault(); if (Object.values(form).some((value) => !value.trim())) return; create.mutate({ data: form }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListOpportunitiesQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); onClose(); } }); };
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

function OpportunityDetailPage() {
  const params = useParams<{ id?: string }>();
  const id = Number(params.id || 0);
  const opportunity = useGetOpportunity(id, { query: { enabled: id > 0, queryKey: getGetOpportunityQueryKey(id) } });
  const [tab, setTab] = useState<'overview' | 'evidence'>('overview');
  const detail = opportunity.data;
  return <div><Link href="/oportunidades" className="back-link" data-testid="link-back-opportunities"><ArrowRight size={14} className="rotate-180" /> Volver al inventario</Link><DataState loading={opportunity.isLoading} error={!!opportunity.error} empty={!opportunity.isLoading && !detail} onRetry={() => void opportunity.refetch()}>{detail && <><PageHeader eyebrow={`Registro OP-${String(detail.id).padStart(4, '0')} / Detalle`} title={detail.name} description={detail.description} action={<Badge value={detail.proofStatus} />} /><div className="detail-grid"><section className="panel detail-primary"><div className="detail-score"><div className="score-ring"><strong>{detail.score}</strong><span>de 100</span></div><div><div className="eyebrow">Puntuación de oportunidad</div><h3>{detail.status}</h3><p>Score compuesto de demanda, ejecución y riesgo.</p></div></div><div className="tab-bar"><button className={cx(tab === 'overview' && 'tab-active')} onClick={() => setTab('overview')} data-testid="button-tab-overview">Hipótesis</button><button className={cx(tab === 'evidence' && 'tab-active')} onClick={() => setTab('evidence')} data-testid="button-tab-evidence">Evidencia <span>{detail.evidence?.length || 0}</span></button></div>{tab === 'overview' ? <div className="hypothesis-grid"><Info label="Problema" value={detail.problem} /><Info label="Cliente objetivo" value={detail.targetCustomer} /><Info label="Solución propuesta" value={detail.proposedSolution} /><Info label="Modelo de monetización" value={detail.monetizationMethod} /></div> : <EvidenceList evidence={detail.evidence || []} />}</section><aside className="detail-aside"><div className="panel"><div className="eyebrow">Ficha de decisión</div><div className="decision-facts"><Fact label="Coste estimado" value={`€${detail.estimatedCost}`} /><Fact label="Dificultad" value={detail.difficulty} /><Fact label="Riesgo" value={detail.risk} /><Fact label="Ingresos en" value={detail.timeToRevenue} /></div></div><div className="panel aside-callout"><FileSearch size={19} /><div><strong>Próximo checkpoint</strong><p>Verificar la prueba de demanda antes de solicitar aprobación humana.</p><Link href="/demand-proof" className="text-link" data-testid="link-detail-demand-proof">Abrir prueba <ArrowRight size={13} /></Link></div></div></aside></div></>}</DataState></div>;
}

function Info({ label, value }: { label: string; value: string }) { return <div className="info-block"><span>{label}</span><p>{value}</p></div>; }
function Fact({ label, value }: { label: string; value: string | number }) { return <div className="fact"><span>{label}</span><strong>{value}</strong></div>; }

function EvidenceList({ evidence }: { evidence: Array<{ id: number; source: string; url: string; collectedAt: string; claim: string; verificationStatus: string; contradictions: string[]; gaps: string[]; proofType: string }> }) {
  return <div className="evidence-list">{evidence.map((item) => <article className="evidence-item" key={item.id} data-testid={`card-evidence-${item.id}`}><div className="evidence-heading"><div className="source-icon"><FileSearch size={15} /></div><div><strong>{item.source}</strong><span>{item.proofType} · {formatDate(item.collectedAt)}</span></div><Badge value={item.verificationStatus} small /></div><p className="evidence-claim">“{item.claim}”</p><div className="evidence-foot"><a href={item.url} target="_blank" rel="noreferrer" data-testid={`link-evidence-source-${item.id}`}>Abrir fuente <ExternalLink size={13} /></a><span>{item.contradictions?.length || 0} contradicciones · {item.gaps?.length || 0} brechas</span></div></article>)}</div>;
}

function DemandProofPage() {
  const proof = useListDemandProof();
  const opportunities = useListOpportunities();
  const names = useMemo(() => new Map((opportunities.data || []).map((opportunity) => [opportunity.id, opportunity.name])), [opportunities.data]);
  return <div><PageHeader eyebrow="Validación / 03" title="Prueba de demanda" description="No confundas una búsqueda con una señal. Aquí se separa lo observado de lo que aún necesita prueba." action={<div className="legend"><Badge value="REAL_VERIFIED" small /><Badge value="REAL_UNVERIFIED" small /><Badge value="SEARCH_EVIDENCE" small /><Badge value="TEST_SIMULATION" small /></div>} /><div className="proof-banner"><div className="proof-banner-icon"><ShieldCheck size={20} /></div><div><strong>Taxonomía de evidencia activa</strong><p>Los estados no son decoración: determinan cuánto puede avanzar una oportunidad sin intervención humana.</p></div><div className="proof-count">{proof.data?.length || 0}<small>registros</small></div></div><DataState loading={proof.isLoading} error={!!proof.error} empty={!proof.isLoading && !proof.data?.length} onRetry={() => void proof.refetch()}><div className="table-card"><div className="table-head"><span>Oportunidad</span><span>Tipo de prueba</span><span>Resumen</span><span>Estado</span><span>Fecha</span></div>{(proof.data || []).map((item) => <div className="table-row" key={item.id} data-testid={`row-demand-proof-${item.id}`}><div className="table-title"><span className="mini-id">DP-{String(item.id).padStart(3, '0')}</span><strong>{names.get(item.opportunityId) || `Oportunidad #${item.opportunityId}`}</strong></div><span>{item.proofType}</span><span className="table-summary">{item.summary}</span><Badge value={item.status} small /><span className="muted-text">{formatDate(item.createdAt)}</span></div>)}</div></DataState></div>;
}

function ProjectsPage() {
  const projects = useListProjects();
  return <div><PageHeader eyebrow="Construcción / 04" title="Proyectos" description="El inventario que sobrevivió a la evidencia y obtuvo permiso para existir." action={<div className="header-stamp"><TerminalSquare size={15} /> Registro de ejecución</div>} /><DataState loading={projects.isLoading} error={!!projects.error} empty={!projects.isLoading && !projects.data?.length} onRetry={() => void projects.refetch()}><div className="project-grid">{(projects.data || []).map((project) => <div className="project-card" key={project.id} data-testid={`card-project-${project.id}`}><div className="project-top"><span className="record-id">PR-{String(project.id).padStart(4, '0')}</span><Badge value={project.status} small /></div><div className="project-mark"><Layers3 size={20} /></div><h3>{project.name}</h3><p>Derivado de oportunidad #{project.opportunityId}</p><div className="project-foot"><span>{formatDate(project.createdAt)}</span><Link href={`/oportunidades/${project.opportunityId}`} data-testid={`link-project-opportunity-${project.id}`}>Ver origen <ArrowRight size={13} /></Link></div></div>)}</div></DataState></div>;
}

function ExecutionPage() {
  const activity = useListActivity();
  return <div><PageHeader eyebrow="Observabilidad / 05" title="Ejecución" description="Una línea de tiempo auditable para cada búsqueda, verificación y decisión del sistema." action={<div className="header-stamp"><ActivityIcon size={15} /> Telemetría en vivo</div>} /><div className="execution-layout"><section className="panel execution-panel"><div className="panel-heading"><div><div className="eyebrow">Log operativo</div><h3>Actividad del pipeline</h3></div><Badge value="ACTIVE" /></div><DataState loading={activity.isLoading} error={!!activity.error} empty={!activity.isLoading && !activity.data?.length} onRetry={() => void activity.refetch()}><ActivityList activities={activity.data} /></DataState></section><aside className="execution-side"><div className="panel"><div className="eyebrow">Etapas del sistema</div><div className="stage-list">{['DISCOVERY', 'SEARCH_EVIDENCE', 'VERIFICATION', 'SCORING', 'HUMAN_APPROVAL'].map((stage, index) => <div className="stage-row" key={stage}><span className={cx('stage-number', index < 3 && 'stage-done')}>{index < 3 ? <Check size={12} /> : index + 1}</span><strong>{stage.replaceAll('_', ' ')}</strong><span className={index < 3 ? 'stage-live' : 'stage-wait'}>{index < 3 ? 'listo' : 'en espera'}</span></div>)}</div></div><div className="panel trace-card"><div className="eyebrow">Integridad del log</div><div className="trace-line"><span className="pulse-dot" /> <strong>Hash verificado</strong></div><p>Los eventos se registran con contexto de ejecución y marca temporal.</p></div></aside></div></div>;
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
  const decision = (id: number, value: 'approved' | 'rejected') => decide.mutate({ id, data: { decision: value } }, { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListApprovalsQueryKey() }) });
  return <div className="settings-approvals"><div className="panel-heading"><div><div className="eyebrow">Gobernanza</div><h3>Decisiones pendientes</h3></div><Badge value="PENDING" /></div><DataState loading={approvals.isLoading} error={!!approvals.error} empty={!approvals.isLoading && !approvals.data?.length} onRetry={() => void approvals.refetch()}>{(approvals.data || []).map((approval) => <div className="approval-detail" key={approval.id} data-testid={`card-setting-approval-${approval.id}`}><div><strong>Checkpoint {approval.type}</strong><p>{approval.reason}</p><span>Creado {formatDate(approval.createdAt)}</span></div><div className="approval-actions"><button className="button button-secondary button-small" onClick={() => decision(approval.id, 'rejected')} disabled={decide.isPending} data-testid={`button-reject-${approval.id}`}><X size={14} /> Rechazar</button><button className="button button-primary button-small" onClick={() => decision(approval.id, 'approved')} disabled={decide.isPending} data-testid={`button-approve-setting-${approval.id}`}><Check size={14} /> Aprobar</button></div></div>)}</DataState></div>;
}

function SettingsPage() {
  const health = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey() } });
  const [saved, setSaved] = useState(false);
  return <div><PageHeader eyebrow="Sistema / 08" title="Configuración" description="Conexiones, gobernanza y límites que mantienen el sistema serio." action={<button className="button button-primary" onClick={() => setSaved(true)} data-testid="button-save-settings"><Check size={15} /> {saved ? 'Cambios guardados' : 'Guardar cambios'}</button>} /><div className="settings-layout"><section className="panel integrations"><div className="panel-heading"><div><div className="eyebrow">Dependencias externas</div><h3>Integraciones</h3></div><Badge value="NOT_CONFIGURED" small /></div><p className="section-intro">Estas conexiones son explícitas. Nada entra al pipeline sin una fuente identificable.</p>{['Search intelligence', 'Signals warehouse', 'Revenue attribution'].map((name, index) => <div className="integration-row" key={name} data-testid={`row-integration-${index}`}><div className="integration-symbol">{index === 0 ? <Search size={16} /> : index === 1 ? <Database size={16} /> : <BarChart3 size={16} />}</div><div><strong>{name}</strong><span>{index === 0 ? 'Búsqueda y captura de evidencia' : index === 1 ? 'Persistencia de fuentes verificadas' : 'Medición de resultados'}</span></div><Badge value="NOT_CONFIGURED" small /><button className="button button-quiet button-small" onClick={() => setSaved(false)} data-testid={`button-configure-integration-${index}`}><Settings2 size={13} /> Configurar</button></div>)}</section><aside className="settings-side"><div className="panel system-health"><div className="eyebrow">Health check</div><div className="health-value"><span className={cx('pulse-dot', health.data?.status === 'ok' && 'health-ok')} />{health.data?.status ? statusLabel(health.data.status) : health.isLoading ? 'consultando' : 'no disponible'}</div><p>Última comprobación contra el servicio de API.</p><button className="text-link" onClick={() => void health.refetch()} data-testid="button-refresh-health"><RefreshCw size={13} /> Actualizar</button></div><div className="panel"><div className="eyebrow">Política operativa</div><div className="policy-row"><ShieldCheck size={16} /><span>Revisión humana obligatoria</span><strong>ON</strong></div><div className="policy-row"><Clock3 size={16} /><span>Retención de evidencia</span><strong>90 días</strong></div></div></aside></div><ApprovalsPanel /></div>;
}

function Router() {
  return <Shell><ErrorBoundary resetKey={window.location.pathname}><Switch><Route path="/" component={DashboardPage} /><Route path="/oportunidades" component={OpportunitiesPage} /><Route path="/oportunidades/:id" component={OpportunityDetailPage} /><Route path="/demand-proof" component={DemandProofPage} /><Route path="/proyectos" component={ProjectsPage} /><Route path="/ejecucion" component={ExecutionPage} /><Route path="/resultados" component={ResultsPage} /><Route path="/aprendizaje" component={LearningPage} /><Route path="/configuracion" component={SettingsPage} /><Route component={NotFound} /></Switch></ErrorBoundary></Shell>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><Router /><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;