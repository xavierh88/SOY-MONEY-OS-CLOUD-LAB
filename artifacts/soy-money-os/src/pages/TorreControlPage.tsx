import { Link } from 'wouter';
import { Radar, ArrowRight, ShieldAlert, Sparkles, Layers3, ActivityIcon } from 'lucide-react';
import { useGetControlTowerOverview, useGetControlTowerTimeline } from '@workspace/api-client-react';
import { PageHeader, DataState, MetricCard, cx, statusTone, formatTime, formatDate, Badge } from '@/App';

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
          </>
        )}
      </DataState>
    </div>
  );
}
