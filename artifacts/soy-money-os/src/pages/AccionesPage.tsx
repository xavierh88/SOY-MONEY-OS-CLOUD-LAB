import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Check, X, ShieldAlert, ArrowRight } from 'lucide-react';
import { Link } from 'wouter';
import { 
  useListHumanActions, 
  useCompleteHumanAction,
  useRecordProjectResult,
  getListHumanActionsQueryKey,
  getGetControlTowerOverviewQueryKey,
  getGetControlTowerTimelineQueryKey
} from '@workspace/api-client-react';
import { PageHeader, DataState, Badge, formatDate, formatTime } from '@/App';

export default function AccionesPage() {
  const queryClient = useQueryClient();
  const [decisionMessage, setDecisionMessage] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<number | null>(null);
  const { data: actions, isLoading, error, refetch } = useListHumanActions();
  const completeAction = useCompleteHumanAction();
  const continueProject = useRecordProjectResult();

  const handleDecision = (id: number, approved: boolean) => {
    setDecidingId(id);
    setDecisionMessage(null);
    completeAction.mutate(
      { id, data: { payload: { approved } } },
      { onSuccess: () => {
        setDecisionMessage(approved
          ? `ACT-${String(id).padStart(4, '0')} aprobada. La decisión quedó registrada; la continuación se ejecuta únicamente por la ruta explícita del mismo proyecto.`
          : `ACT-${String(id).padStart(4, '0')} rechazada. La rama permanece bloqueada.`);
        queryClient.invalidateQueries({ queryKey: getListHumanActionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetControlTowerOverviewQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetControlTowerTimelineQueryKey() });
      }, onError: (mutationError) => {
        setDecisionMessage(mutationError instanceof Error ? mutationError.message : 'La decisión no pudo persistirse.');
      }, onSettled: () => setDecidingId(null) }
    );
  };
  const handleContinuation = (projectId: number) => {
    setDecisionMessage(null);
    continueProject.mutate({ id: projectId }, {
      onSuccess: () => {
        setDecisionMessage(`Proyecto PRJ-${projectId} continuó por la ruta explícita del mismo proyecto.`);
        queryClient.invalidateQueries({ queryKey: getListHumanActionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetControlTowerOverviewQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetControlTowerTimelineQueryKey() });
      },
      onError: (mutationError) => {
        setDecisionMessage(mutationError instanceof Error ? mutationError.message : 'La continuación no pudo persistirse.');
      },
    });
  };

  const pendingActions = (actions || []).filter(a => a.status === 'PENDING');
  const completedActions = (actions || []).filter(a => a.status === 'COMPLETED' || a.status === 'CANCELLED');

  return (
    <div>
      <PageHeader 
        eyebrow="Operación / 05" 
        title="Cola de Acciones Humanas" 
        description="Los checkpoints que requieren intervención aparecen aquí. Aprobar marca el checkpoint como listo para reanudación; rechazar mantiene el ciclo bloqueado."
      />
      {decisionMessage && <div className="panel mb-4 text-sm" role="status">{decisionMessage}</div>}

      <div className="grid gap-6">
        <section className="panel">
          <div className="panel-heading border-b pb-4 mb-4" style={{ borderColor: 'hsl(var(--border))' }}>
            <div>
              <div className="eyebrow flex items-center gap-2"><ShieldAlert size={12} /> PENDIENTES DE REVISIÓN</div>
              <h3>Requieren tu atención ({pendingActions.length})</h3>
            </div>
          </div>
          
          <DataState loading={isLoading} error={!!error} errorDetail={error instanceof Error ? error.message : undefined} empty={!isLoading && pendingActions.length === 0} onRetry={() => void refetch()}>
            <div className="opportunity-list">
              {pendingActions.map(action => (
                <div key={action.id} className="opportunity-card" style={{ borderColor: 'hsl(var(--sidebar-primary))' }}>
                  <div className="opportunity-top">
                    <span className="record-id">ACT-{String(action.id).padStart(4, '0')}</span>
                    <Badge value={action.status} small />
                    <span className="card-date">{formatDate(action.createdAt)} {formatTime(action.createdAt)}</span>
                  </div>
                  <div className="py-5 flex flex-col lg:flex-row lg:justify-between lg:items-center gap-6">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-base font-semibold mb-2">
                        {action.actionType} — {action.checkpoint}
                      </h3>
                      {action.opportunity && (
                        <div className="mb-3 rounded border border-border bg-card p-3 text-xs">
                          <div className="flex flex-wrap items-center gap-2">
                            <strong>{action.opportunity.name}</strong>
                            <Badge value={action.opportunity.proofStatus} small />
                            <span className="font-mono">Score {action.score ?? action.opportunity.score}/100</span>
                          </div>
                          <p className="mt-1 text-muted-foreground">{action.opportunity.titleClaim || action.opportunity.description}</p>
                        </div>
                      )}
                      <div className="flex gap-3 text-xs mb-2">
                        {action.project && <Link href={`/proyectos/${action.project.id}`} className="text-link">Proyecto {action.project.name}</Link>}
                        {action.opportunity && <Link href={`/oportunidades/${action.opportunity.id}`} className="text-link">Oportunidad {action.opportunity.name}</Link>}
                      </div>
                      <div className="mb-3 text-xs">
                        <strong>Decisión necesaria: </strong>
                        {action.decision?.nextAction || 'OWNER_APPROVAL_REQUIRED'}
                        {action.decision?.decisionReason && <span className="ml-1 text-muted-foreground">— {action.decision.decisionReason}</span>}
                      </div>
                      {action.evidence.length > 0 && (
                        <div className="mb-3 text-xs">
                          <strong>Fuentes de evidencia corroboradas:</strong>
                          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                            {action.evidence.map(evidence => (
                              <li key={evidence.id}>
                                {evidence.source} · <a href={evidence.url} target="_blank" rel="noreferrer" className="underline">{evidence.url}</a>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground font-mono bg-secondary p-3 mt-2 rounded-sm whitespace-pre-wrap break-words">
                        {JSON.stringify(action.payload, null, 2)}
                      </p>
                    </div>
                    <div className="flex flex-col sm:flex-row lg:flex-col gap-2 w-full lg:w-auto lg:min-w-[140px]">
                      <button 
                        className="button button-primary w-full justify-center" 
                        onClick={() => handleDecision(action.id, true)} 
                        disabled={completeAction.isPending || decidingId === action.id}
                        data-testid={`button-approve-action-${action.id}`}
                      >
                        <Check size={16} /> APROBAR
                      </button>
                      <button 
                        className="button button-secondary w-full justify-center text-destructive hover:bg-destructive/10" 
                        style={{ color: 'hsl(var(--destructive))' }}
                        onClick={() => handleDecision(action.id, false)} 
                        disabled={completeAction.isPending || decidingId === action.id}
                        data-testid={`button-reject-action-${action.id}`}
                      >
                        <X size={16} /> RECHAZAR
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </DataState>
        </section>

        {completedActions.length > 0 && (
          <section className="panel opacity-80">
            <div className="panel-heading border-b pb-4 mb-4" style={{ borderColor: 'hsl(var(--border))' }}>
              <div>
                <div className="eyebrow">HISTORIAL</div>
                <h3>Acciones completadas ({completedActions.length})</h3>
              </div>
            </div>
            <div className="opportunity-list">
              {completedActions.map(action => (
                <div key={action.id} className="opportunity-card bg-secondary/30">
                  <div className="opportunity-top">
                    <span className="record-id">ACT-{String(action.id).padStart(4, '0')}</span>
                    <Badge value={action.status} small />
                    <span className="card-date">{formatDate(action.completedAt)}</span>
                  </div>
                  <div className="py-2">
                    <h3 className="text-sm font-semibold mb-1">{action.actionType}</h3>
                    <p className="text-[10px] text-muted-foreground uppercase">{action.checkpoint}</p>
                    {action.opportunity && <p className="text-xs mt-1">{action.opportunity.name} · Score {action.score ?? action.opportunity.score}/100</p>}
                    {action.project && <Link href={`/proyectos/${action.project.id}`} className="text-link text-xs">Mismo proyecto: {action.project.name}</Link>}
                    {action.continuation?.available && (
                      <div className="mt-2">
                        <p className="text-xs text-muted-foreground">
                          Continuación explícita disponible para el mismo proyecto:
                          {' '}{action.continuation.method} {action.continuation.path}
                        </p>
                        {action.checkpoint === 'MONETIZATION_REVIEW' && action.projectId && (
                          <button
                            className="button button-primary button-small mt-2"
                            onClick={() => handleContinuation(action.projectId!)}
                            disabled={continueProject.isPending}
                            data-testid={`button-continue-project-${action.projectId}`}
                          >
                            <ArrowRight size={14} /> CONTINUAR MISMO PROYECTO
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
