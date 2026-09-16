import { Link } from 'wouter';
import { Radar, ArrowRight, ShieldAlert, Sparkles, Layers3, ActivityIcon, Search, RefreshCw, X, ExternalLink } from 'lucide-react';
import { useGetControlTowerOverview, useGetControlTowerTimeline, useListDiscoveryResearch, useResearchDiscovery, useGetDiscoveryResearch, getListDiscoveryResearchQueryKey, getGetDiscoveryResearchQueryKey, useListNotifications, useMarkNotificationRead, getListNotificationsQueryKey, useListIncidents, useAcknowledgeIncident, getListIncidentsQueryKey, useListDeadLetterEvents, useRetryDeadLetterEvent, getListDeadLetterEventsQueryKey } from '@workspace/api-client-react';
import { PageHeader, DataState, MetricCard, cx, statusTone, formatTime, formatDate, Badge } from '@/App';
import { useState, FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';

function DiscoveryDetailModal({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, isLoading, error } = useGetDiscoveryResearch(id, { query: { enabled: !!id, queryKey: getGetDiscoveryResearchQueryKey(id) } });

  return (
    <div className="modal-backdrop">
      <div className="modal modal-large">
        <div className="modal-heading">
          <div>
            <div className="eyebrow">Detalle de Research</div>
            <h2>Ejecución DR-{id}</h2>
          </div>
          <button className="icon-button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body p-6 max-h-[70vh] overflow-y-auto">
          <DataState loading={isLoading} error={!!error} empty={!isLoading && !data}>
            {data && (
              <div className="space-y-6">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="p-3 bg-secondary/30 rounded border border-border">
                    <div className="text-[10px] text-muted-foreground uppercase">Estado</div>
                    <div className="mt-1"><Badge value={data.run.status} small /></div>
                  </div>
                  <div className="p-3 bg-secondary/30 rounded border border-border">
                    <div className="text-[10px] text-muted-foreground uppercase">Resultado</div>
                    <div className="mt-1"><strong className={data.accepted ? 'text-[hsl(145_43%_41%)]' : 'text-[hsl(var(--destructive))]'}>{data.accepted ? 'ACEPTADO' : 'RECHAZADO'}</strong></div>
                  </div>
                  <div className="p-3 bg-secondary/30 rounded border border-border">
                    <div className="text-[10px] text-muted-foreground uppercase">Score Final</div>
                    <div className="mt-1 font-mono">{Object.values(data.run.scoreBreakdown || {}).reduce((a, b) => a + b, 0)} pts</div>
                  </div>
                  <div className="p-3 bg-secondary/30 rounded border border-border">
                    <div className="text-[10px] text-muted-foreground uppercase">Duración</div>
                    <div className="mt-1 text-xs font-mono">{formatTime(data.run.startedAt)} - {data.run.completedAt ? formatTime(data.run.completedAt) : '...'}</div>
                  </div>
                </div>

                {data.run.rejectionReason && (
                  <div className="p-3 bg-red-500/10 border border-red-500/20 rounded text-red-500 text-sm">
                    <strong className="block mb-1">Motivo de rechazo: NO_VALID_OPPORTUNITY</strong>
                    {data.run.rejectionReason}
                  </div>
                )}

                <div>
                  <h4 className="text-sm font-semibold mb-3 border-b border-border pb-2">Breakdown de Score</h4>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(data.run.scoreBreakdown || {}).map(([k, v]) => (
                      <div key={k} className="px-2 py-1 bg-secondary rounded text-xs font-mono flex gap-2">
                        <span className="text-muted-foreground">{k}:</span>
                        <span>{v}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <h4 className="text-sm font-semibold mb-3 border-b border-border pb-2">Hallazgos y Fuentes ({data.findings?.length || 0})</h4>
                  <div className="space-y-3">
                    {(data.findings || []).map((f: any, i: number) => (
                      <div key={i} className="p-3 border border-border rounded bg-card text-sm">
                        <div className="flex justify-between items-start mb-2">
                          <strong className="text-accent">{f.titleClaim || 'Sin título'}</strong>
                          <Badge value={f.evidenceType || 'SEARCH_EVIDENCE'} small />
                        </div>
                        <p className="text-xs text-muted-foreground mb-2">{f.excerpt}</p>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono">
                          {f.sourceUrl ? (
                            <a href={f.sourceUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline flex items-center gap-1">
                              Fuente <ExternalLink size={10} />
                            </a>
                          ) : (
                            <span className="text-muted-foreground">Fuente: {f.source}</span>
                          )}
                          <span className="text-muted-foreground">Score: {f.freshnessScore || 0}</span>
                          {f.fingerprint && <span className="text-muted-foreground">FP: {f.fingerprint.substring(0, 8)}...</span>}
                          {f.independenceKey && <span className="text-muted-foreground">Indep: {f.independenceKey}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

              </div>
            )}
          </DataState>
        </div>
      </div>
    </div>
  );
}

function DiscoveryPanel() {
  const queryClient = useQueryClient();
  const list = useListDiscoveryResearch();
  const research = useResearchDiscovery();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [category, setCategory] = useState<string>('BUSINESS');
  const [query, setQuery] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    research.mutate({
      data: {
        category: category as any,
        query: query.trim() || undefined,
        idempotencyKey: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2)
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDiscoveryResearchQueryKey() });
        setQuery('');
      }
    });
  };

  return (
    <section className="panel mt-6">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">Discovery / Research Pública</div>
          <h3>Exploración de Mercado Independiente</h3>
        </div>
      </div>

      <div className="p-4 bg-secondary/30 border-b border-border">
        <form onSubmit={submit} className="flex gap-2 items-end">
          <label className="field flex-1 max-w-[250px]">
            <span>Categoría</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)} data-testid="select-discovery-category">
              <option value="BUSINESS">Negocios</option>
              <option value="DIGITAL_PRODUCTS">Productos Digitales</option>
              <option value="SERVICES">Servicios</option>
              <option value="SAAS">SaaS</option>
              <option value="AUTOMATION">Automatización</option>
              <option value="AFFILIATE">Afiliados</option>
              <option value="SPORTS">Deportes (Solo Research)</option>
              <option value="OTHER_LEGAL_OPPORTUNITIES">Otras Oportunidades</option>
            </select>
          </label>
          <label className="field flex-1">
            <span>Query (Opcional)</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Ej. herramientas b2b" data-testid="input-discovery-query" />
          </label>
          <button type="submit" className="button button-primary" disabled={research.isPending} data-testid="button-start-discovery">
            {research.isPending ? <RefreshCw size={14} className="spin" /> : <Search size={14} />}
            Iniciar Research
          </button>
        </form>
        <p className="text-[10px] text-muted-foreground mt-2">
          La evidencia obtenida se clasifica como SEARCH_EVIDENCE. No equivale a demanda real (REAL_VERIFIED). Los sectores MARKET/CRYPTO requieren Money Lab y SPORTS es de solo-lectura.
        </p>
      </div>

      <DataState loading={list.isLoading} error={!!list.error} empty={!list.isLoading && (!list.data || list.data.length === 0)}>
        <div className="table-responsive">
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="border-b border-border">
                <th className="p-3 font-semibold text-xs text-muted-foreground">ID / FECHA</th>
                <th className="p-3 font-semibold text-xs text-muted-foreground">CATEGORÍA / QUERY</th>
                <th className="p-3 font-semibold text-xs text-muted-foreground">FUENTES</th>
                <th className="p-3 font-semibold text-xs text-muted-foreground">ACEPTADOS</th>
                <th className="p-3 font-semibold text-xs text-muted-foreground">ESTADO</th>
                <th className="p-3 font-semibold text-xs text-muted-foreground text-right">ACCIONES</th>
              </tr>
            </thead>
            <tbody>
              {(list.data || []).map((run) => (
                <tr key={run.id} className="border-b border-border last:border-0 hover:bg-secondary/20">
                  <td className="p-3">
                    <div className="font-mono">DR-{run.id}</div>
                    <div className="text-[10px] text-muted-foreground">{formatDate(run.startedAt)}</div>
                  </td>
                  <td className="p-3">
                    <strong>{run.category}</strong>
                    {run.query && <div className="text-[10px] text-muted-foreground uppercase mt-1">Q: {run.query}</div>}
                  </td>
                  <td className="p-3">
                    <div className="text-xs">{run.sourceCount} total</div>
                    <div className="text-[10px] text-muted-foreground">{run.independentSourceCount} indep.</div>
                  </td>
                  <td className="p-3 font-mono">
                    {run.acceptedCount}
                  </td>
                  <td className="p-3">
                    <Badge value={run.status} small />
                  </td>
                  <td className="p-3 text-right">
                    <button className="button button-secondary text-[10px] py-1 px-2 uppercase tracking-wide" onClick={() => setSelectedId(run.id)} data-testid={`button-view-discovery-${run.id}`}>
                      Ver Detalle
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DataState>

      {selectedId && (
        <DiscoveryDetailModal id={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </section>
  );
}




function DeadLetterQueuePanel() {
  const queryClient = useQueryClient();
  const dlq = useListDeadLetterEvents();
  const retry = useRetryDeadLetterEvent({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListDeadLetterEventsQueryKey() });
      },
    },
  });

  const items = dlq.data || [];

  const retryEvent = (id: number) => {
    const idempotencyKey = crypto.randomUUID
      ? crypto.randomUUID()
      : `dlq-retry-${id}-${Date.now()}`;

    retry.mutate({
      id,
      data: {
        idempotencyKey,
        humanCheckpoint: true,
      },
    });
  };

  return (
    <section className="panel mb-6" data-testid="dlq-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">Observabilidad / Recuperación Controlada</div>
          <h3>Dead Letter Queue</h3>
        </div>

        <div className="flex items-center gap-2">
          <Badge value={`${items.length} pendientes`} />
          <button
            className="icon-button"
            onClick={() => void dlq.refetch()}
            aria-label="Actualizar Dead Letter Queue"
            data-testid="button-refresh-dlq"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      <div className="px-4 py-3 border-b border-border bg-secondary/30">
        <p className="text-xs text-muted-foreground">
          Los eventos fallidos no se reintentan automáticamente desde esta vista.
          Cada reintento requiere una acción humana explícita y se ejecuta con una
          clave de idempotencia independiente.
        </p>
      </div>

      <DataState
        loading={dlq.isLoading}
        error={!!dlq.error}
        empty={!dlq.isLoading && items.length === 0}
        onRetry={() => void dlq.refetch()}
      >
        <div className="activity-list activity-compact">
          {items.map((item) => (
            <div
              className="activity-row"
              key={item.id}
              data-testid={`dlq-event-${item.id}`}
            >
              <div className="activity-marker red">
                <span />
              </div>

              <div className="activity-body">
                <div className="activity-meta">
                  <div className="flex items-center gap-2">
                    <Badge value={item.status} small />
                    <span className="font-mono text-[10px]">
                      Intentos: {item.attemptCount}
                    </span>
                  </div>

                  <span>
                    {formatDate(item.createdAt)} {formatTime(item.createdAt)}
                  </span>
                </div>

                <p className="font-semibold text-sm mb-1">{item.eventType}</p>

                <div className="text-xs text-muted-foreground space-y-1">
                  <p>
                    Evento: <span className="font-mono">{item.eventKey}</span>
                  </p>
                  <p>
                    Agregado: <span className="font-mono">
                      {item.aggregateType}/{item.aggregateId}
                    </span>
                  </p>
                  <p>
                    Disponible: {formatDate(item.availableAt)} {formatTime(item.availableAt)}
                  </p>
                </div>

                {item.lastError && (
                  <div className="mt-3 p-3 bg-red-500/10 border border-red-500/20 rounded text-sm">
                    <strong className="block mb-1">Último error</strong>
                    <span className="text-muted-foreground">{item.lastError}</span>
                  </div>
                )}

                <div className="mt-3">
                  <button
                    className="button button-secondary"
                    disabled={retry.isPending}
                    onClick={() => retryEvent(item.id)}
                    data-testid={`button-retry-dlq-${item.id}`}
                  >
                    {retry.isPending ? (
                      <RefreshCw size={14} className="spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    Reintentar con aprobación humana
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </DataState>
    </section>
  );
}

function IncidentsPanel() {
  const queryClient = useQueryClient();
  const incidents = useListIncidents();
  const acknowledge = useAcknowledgeIncident({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListIncidentsQueryKey() });
      },
    },
  });

  const items = incidents.data || [];
  const openCount = items.filter((item) => item.status === 'OPEN').length;

  return (
    <section className="panel mb-6" data-testid="incidents-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">Observabilidad / Operaciones</div>
          <h3>Incidentes</h3>
        </div>
        <div className="flex items-center gap-2">
          <Badge value={`${openCount} abiertos`} />
          <button
            className="icon-button"
            onClick={() => void incidents.refetch()}
            aria-label="Actualizar incidentes"
            data-testid="button-refresh-incidents"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      <DataState
        loading={incidents.isLoading}
        error={!!incidents.error}
        empty={!incidents.isLoading && items.length === 0}
        onRetry={() => void incidents.refetch()}
      >
        <div className="activity-list activity-compact">
          {items.map((item) => (
            <div
              className="activity-row"
              key={item.id}
              data-testid={`incident-${item.id}`}
            >
              <div className={cx(
                'activity-marker',
                item.severity === 'CRITICAL' || item.severity === 'HIGH'
                  ? 'red'
                  : item.severity === 'MEDIUM'
                    ? 'amber'
                    : 'neutral'
              )}>
                <span />
              </div>

              <div className="activity-body">
                <div className="activity-meta">
                  <div className="flex items-center gap-2">
                    <Badge value={item.severity} small />
                    <Badge value={item.status} small />
                  </div>
                  <span>{formatDate(item.createdAt)} {formatTime(item.createdAt)}</span>
                </div>

                <p className="font-semibold text-sm mb-1">{item.title}</p>
                <p className="text-sm text-muted-foreground">{item.summary}</p>

                {item.correlationId && (
                  <p className="text-[10px] font-mono text-muted-foreground mt-2">
                    Correlation ID: {item.correlationId}
                  </p>
                )}

                {item.acknowledgedAt && (
                  <p className="text-[10px] text-muted-foreground mt-2">
                    Reconocido {formatDate(item.acknowledgedAt)} {formatTime(item.acknowledgedAt)}
                    {item.acknowledgedBy ? ` por ${item.acknowledgedBy}` : ''}
                  </p>
                )}

                {item.status === 'OPEN' && (
                  <div className="mt-3">
                    <button
                      className="button button-secondary"
                      disabled={acknowledge.isPending}
                      onClick={() => acknowledge.mutate({ id: item.id })}
                      data-testid={`button-acknowledge-incident-${item.id}`}
                    >
                      Reconocer incidente
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </DataState>
    </section>
  );
}

function NotificationsPanel() {
  const queryClient = useQueryClient();
  const notifications = useListNotifications();
  const markRead = useMarkNotificationRead({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() });
      },
    },
  });

  const items = notifications.data || [];
  const unreadCount = items.filter((item) => !item.readAt).length;

  return (
    <section className="panel mb-6" data-testid="notifications-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">Observabilidad</div>
          <h3>Notificaciones</h3>
        </div>
        <div className="flex items-center gap-2">
          <Badge value={`${unreadCount} sin leer`} />
          <button
            className="icon-button"
            onClick={() => void notifications.refetch()}
            aria-label="Actualizar notificaciones"
            data-testid="button-refresh-notifications"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      <DataState
        loading={notifications.isLoading}
        error={!!notifications.error}
        empty={!notifications.isLoading && items.length === 0}
        onRetry={() => void notifications.refetch()}
      >
        <div className="activity-list activity-compact">
          {items.map((item) => (
            <div
              className="activity-row"
              key={item.id}
              data-testid={`notification-${item.id}`}
            >
              <div className={cx('activity-marker', item.readAt ? 'neutral' : 'blue')}>
                <span />
              </div>

              <div className="activity-body">
                <div className="activity-meta">
                  <strong>{item.readAt ? 'LEÍDA' : 'NUEVA'}</strong>
                  <span>{formatDate(item.createdAt)} {formatTime(item.createdAt)}</span>
                </div>

                <p className="font-semibold text-sm mb-1">{item.title}</p>
                <p className="text-sm text-muted-foreground">{item.body}</p>

                <div className="flex items-center gap-2 mt-3">
                  {!item.readAt && (
                    <button
                      className="button button-secondary"
                      disabled={markRead.isPending}
                      onClick={() => markRead.mutate({ id: item.id })}
                      data-testid={`button-read-notification-${item.id}`}
                    >
                      Marcar como leída
                    </button>
                  )}

                  {item.targetPath && (
                    <Link
                      href={item.targetPath}
                      className="button button-secondary"
                      data-testid={`link-notification-${item.id}`}
                    >
                      Ver detalle <ArrowRight size={14} />
                    </Link>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </DataState>
    </section>
  );
}

export default function TorreControlPage() {
  const overview = useGetControlTowerOverview();
  const timeline = useGetControlTowerTimeline();
  
  const o = overview.data;
  const t = timeline.data || [];
  
  return (
    <div>
      <PageHeader 
        eyebrow="Operación / 00" 
        title="Torre de Control" 
        description="Vista consolidada de actividad persistida, incluyendo resultados reales, simulados y potenciales sin mezclarlos." 
        action={<Link href="/ejecucion" className="button button-secondary"><ActivityIcon size={15} /> Ver Ejecución Completa</Link>}
      />
      
      <DataState loading={overview.isLoading} error={!!overview.error} empty={!overview.isLoading && !o} onRetry={() => void overview.refetch()}>
        {o && (
          <>
            <div className="metric-grid mb-6">
              <MetricCard label="Oportunidades" value={o.opportunities.active || 0} note={`${o.opportunities.total} total`} icon={Radar} tone="lime" />
              <MetricCard label="Proyectos" value={o.projects.active || 0} note={`${o.projects.total} total`} icon={Layers3} tone="blue" />
              <MetricCard label="Acciones Humanas" value={o.humanActions.pending || 0} note={`${o.humanActions.total} total`} icon={ShieldAlert} tone={o.humanActions.pending ? 'amber' : 'neutral'} />
              <MetricCard label="Motor Autónomo" value={o.autonomousCycles.active || 0} note={`${o.autonomousCycles.total} ciclos`} icon={Sparkles} tone="coral" />
            </div>

            <div className="dashboard-grid mb-6">
              <section className="panel" style={{ borderColor: 'hsl(var(--sidebar-primary))' }}>
                <div className="panel-heading">
                  <div>
                    <div className="eyebrow">Motor de Señales</div>
                    <h3>Próxima acción requerida</h3>
                  </div>
                </div>
                <div className="p-4 bg-secondary rounded flex flex-col gap-2">
                  <div className="flex gap-2">
                    <strong>Actual:</strong>
                    <span className="font-mono text-sm">{o.currentAction || 'MONITOREANDO'}</span>
                  </div>
                  <div className="flex gap-2 text-muted-foreground">
                    <strong>Siguiente:</strong>
                    <span className="font-mono text-sm">{o.nextAction || 'ESPERANDO SEÑAL'}</span>
                  </div>
                </div>
              </section>

              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <div className="eyebrow">Guardrails (Money Lab)</div>
                    <h3>Protecciones Activas</h3>
                  </div>
                </div>
                <div className="flex flex-col gap-2 font-mono text-xs">
                  <div className="flex justify-between p-2 border-b" style={{ borderColor: 'hsl(var(--border))' }}>
                    <span>Dinero Real Usado:</span>
                    <strong style={{ color: o.moneyLab.guardrails.realMoneyUsed ? 'hsl(var(--destructive))' : 'hsl(145 43% 41%)' }}>
                      {o.moneyLab.guardrails.realMoneyUsed ? 'TRUE' : 'FALSE'}
                    </strong>
                  </div>
                  <div className="flex justify-between p-2 border-b" style={{ borderColor: 'hsl(var(--border))' }}>
                    <span>Ejecución Financiera:</span>
                    <strong style={{ color: o.moneyLab.guardrails.financialExecution ? 'hsl(var(--destructive))' : 'hsl(145 43% 41%)' }}>
                      {o.moneyLab.guardrails.financialExecution ? 'TRUE' : 'FALSE'}
                    </strong>
                  </div>
                  <div className="flex justify-between p-2">
                    <span>Dinero Real Verificado:</span>
                    <strong style={{ color: o.moneyLab.guardrails.realVerified ? 'hsl(var(--destructive))' : 'hsl(145 43% 41%)' }}>
                      {o.moneyLab.guardrails.realVerified ? 'TRUE' : 'FALSE'}
                    </strong>
                  </div>
                </div>
              </section>
            </div>

            <NotificationsPanel />
            <IncidentsPanel />
            <DeadLetterQueuePanel />
            
            <section className="panel activity-panel">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">Timeline Persistido</div>
                  <h3>Eventos Operativos Recientes</h3>
                </div>
                <Link href="/ejecucion" className="icon-link">
                  <ArrowRight size={17} />
                </Link>
              </div>
              <DataState loading={timeline.isLoading} error={!!timeline.error} empty={!timeline.isLoading && t.length === 0} onRetry={() => void timeline.refetch()}>
                <div className="activity-list activity-compact">
                  {t.slice(0, 10).map((event, index) => (
                    <div className="activity-row" key={`${event.sourceId}-${index}`}>
                      <div className={cx('activity-marker', statusTone(event.status))}><span /></div>
                      <div className="activity-body">
                        <div className="activity-meta">
                          <strong>{event.eventType}</strong>
                          <span>{formatDate(event.timestamp)} {formatTime(event.timestamp)}</span>
                        </div>
                        <p className="font-semibold text-sm mb-1">{event.title}</p>
                        <p>{event.description}</p>
                        <div className="mt-2 flex gap-2">
                          <Badge value={event.status} small />
                          <Badge value={event.sourceType} small />
                          {event.opportunityId && (
                            <Link href={`/oportunidades/${event.opportunityId}`} className="text-[10px] text-muted-foreground hover:text-foreground">
                              OP-{event.opportunityId}
                            </Link>
                          )}
                          {event.projectId && (
                            <Link href={`/proyectos/${event.projectId}`} className="text-[10px] text-muted-foreground hover:text-foreground">
                              PRJ-{event.projectId}
                            </Link>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </DataState>
            </section>

            <DiscoveryPanel />
          </>
        )}
      </DataState>
    </div>
  );
}
