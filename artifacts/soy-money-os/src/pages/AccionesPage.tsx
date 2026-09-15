import { useQueryClient } from '@tanstack/react-query';
import { Check, X, ShieldAlert } from 'lucide-react';
import { Link } from 'wouter';
import { 
  useListHumanActions, 
  useCompleteHumanAction,
  getListHumanActionsQueryKey,
  getGetControlTowerOverviewQueryKey,
  getGetControlTowerTimelineQueryKey
} from '@workspace/api-client-react';
import { PageHeader, DataState, Badge, formatDate, formatTime } from '@/App';

export default function AccionesPage() {
  const queryClient = useQueryClient();
  const { data: actions, isLoading, error, refetch } = useListHumanActions();
  const completeAction = useCompleteHumanAction();

  const handleDecision = (id: number, approved: boolean) => {
    completeAction.mutate(
      { id, data: { payload: { approved } } },
      { onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListHumanActionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetControlTowerOverviewQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetControlTowerTimelineQueryKey() });
      } }
    );
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

      <div className="grid gap-6">
        <section className="panel">
          <div className="panel-heading border-b pb-4 mb-4" style={{ borderColor: 'hsl(var(--border))' }}>
            <div>
              <div className="eyebrow flex items-center gap-2"><ShieldAlert size={12} /> PENDIENTES DE REVISIÓN</div>
              <h3>Requieren tu atención ({pendingActions.length})</h3>
            </div>
          </div>
          
          <DataState loading={isLoading} error={!!error} empty={!isLoading && pendingActions.length === 0} onRetry={() => void refetch()}>
            <div className="opportunity-list">
              {pendingActions.map(action => (
                <div key={action.id} className="opportunity-card" style={{ borderColor: 'hsl(var(--sidebar-primary))' }}>
                  <div className="opportunity-top">
                    <span className="record-id">ACT-{String(action.id).padStart(4, '0')}</span>
                    <Badge value={action.status} small />
                    <span className="card-date">{formatDate(action.createdAt)} {formatTime(action.createdAt)}</span>
                  </div>
                  <div className="py-5 flex justify-between items-center gap-6">
                    <div>
                      <h3 className="text-base font-semibold mb-2">{action.actionType} — {action.checkpoint}</h3>
                      <div className="flex gap-3 text-xs mb-2">
                        {action.projectId && <Link href={`/proyectos/${action.projectId}`} className="text-link">Proyecto PRJ-{action.projectId}</Link>}
                        {action.opportunityId && <Link href={`/oportunidades/${action.opportunityId}`} className="text-link">Oportunidad OP-{action.opportunityId}</Link>}
                      </div>
                      <p className="text-xs text-muted-foreground font-mono bg-secondary p-3 mt-2 rounded-sm overflow-x-auto whitespace-pre">
                        {JSON.stringify(action.payload, null, 2)}
                      </p>
                    </div>
                    <div className="flex flex-col gap-2 min-w-[140px]">
                      <button 
                        className="button button-primary w-full justify-center" 
                        onClick={() => handleDecision(action.id, true)} 
                        disabled={completeAction.isPending}
                        data-testid={`button-approve-action-${action.id}`}
                      >
                        <Check size={16} /> APROBAR
                      </button>
                      <button 
                        className="button button-secondary w-full justify-center text-destructive hover:bg-destructive/10" 
                        style={{ color: 'hsl(var(--destructive))' }}
                        onClick={() => handleDecision(action.id, false)} 
                        disabled={completeAction.isPending}
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
