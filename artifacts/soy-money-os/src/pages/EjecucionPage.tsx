import { useGetControlTowerTimeline } from '@workspace/api-client-react';
import { PageHeader, DataState, cx, statusTone, formatTime, formatDate, Badge } from '@/App';
import { Link } from 'wouter';

export default function EjecucionPage() {
  const timeline = useGetControlTowerTimeline();
  const t = timeline.data || [];

  return (
    <div>
      <PageHeader 
        eyebrow="Trazabilidad / 03" 
        title="Ejecución" 
        description="Historial operativo unificado de decisiones, descubrimientos y resultados." 
      />
      
      <section className="panel">
        <DataState loading={timeline.isLoading} error={!!timeline.error} empty={!timeline.isLoading && t.length === 0} onRetry={() => void timeline.refetch()}>
          <div className="activity-list">
            {t.map((event, index) => (
              <div className="activity-row" key={`${event.sourceId}-${index}`}>
                <div className={cx('activity-marker', statusTone(event.status))}><span /></div>
                <div className="activity-body">
                  <div className="activity-meta">
                    <strong>{event.eventType}</strong>
                    <span>{formatDate(event.timestamp)} {formatTime(event.timestamp)}</span>
                  </div>
                  <h4 className="font-semibold text-base mb-1">{event.title}</h4>
                  <p className="mb-2 text-sm text-muted-foreground">{event.description}</p>
                  
                  {event.currentAction && (
                    <div className="text-xs font-mono bg-secondary p-2 mb-2 rounded">
                      <div className="text-muted-foreground">ACTUAL: <span className="text-foreground">{event.currentAction}</span></div>
                      {event.nextAction && <div>SIGUIENTE: <span className="text-foreground">{event.nextAction}</span></div>}
                    </div>
                  )}

                  <div className="mt-3 flex gap-2 flex-wrap">
                    <Badge value={event.status} small />
                    <Badge value={event.sourceType} small />
                    {event.opportunityId && (
                      <Link href={`/oportunidades/${event.opportunityId}`} className="text-[10px] text-muted-foreground hover:text-foreground border border-border px-1">
                        OP-{event.opportunityId}
                      </Link>
                    )}
                    {event.projectId && (
                      <Link href={`/proyectos/${event.projectId}`} className="text-[10px] text-muted-foreground hover:text-foreground border border-border px-1">
                        PRJ-{event.projectId}
                      </Link>
                    )}
                    {event.marketCycleId && (
                      <span className="text-[10px] text-muted-foreground border border-border px-1">
                        MC-{event.marketCycleId}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </DataState>
      </section>
    </div>
  );
}
