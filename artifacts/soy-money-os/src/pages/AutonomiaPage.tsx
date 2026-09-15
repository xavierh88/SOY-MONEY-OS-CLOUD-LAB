import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Clock3, Play, Pause, SquareSquare, FastForward, ActivityIcon, Settings2, Plus, StopCircle } from 'lucide-react';
import { 
  useGetAutonomyStatus, 
  useStartAutonomy, 
  useStopAutonomy, 
  usePauseAutonomy, 
  useResumeAutonomy, 
  useRunAutonomousCycle, 
  useListAutonomousCycles, 
  useListAutonomyActivity,
  getGetAutonomyStatusQueryKey,
  getListAutonomousCyclesQueryKey,
  getListAutonomyActivityQueryKey,
  getGetControlTowerOverviewQueryKey,
  getGetControlTowerTimelineQueryKey,
  AutonomyControlInput
} from '@workspace/api-client-react';
import { cx, PageHeader, DataState, Badge, statusTone, statusLabel, formatDate, formatTime } from '@/App';

export default function AutonomiaPage() {
  const queryClient = useQueryClient();
  const statusQuery = useGetAutonomyStatus();
  const cyclesQuery = useListAutonomousCycles();
  const activityQuery = useListAutonomyActivity();
  
  const startAutonomy = useStartAutonomy();
  const stopAutonomy = useStopAutonomy();
  const pauseAutonomy = usePauseAutonomy();
  const resumeAutonomy = useResumeAutonomy();
  const runCycle = useRunAutonomousCycle();

  const [formOpen, setFormOpen] = useState(false);
  const [config, setConfig] = useState<AutonomyControlInput>({
    timezone: 'America/Los_Angeles',
    dailySlots: ['06:00', '10:00', '14:00', '18:00', '22:00']
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetAutonomyStatusQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListAutonomousCyclesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListAutonomyActivityQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetControlTowerOverviewQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetControlTowerTimelineQueryKey() });
  };

  const handleStart = () => {
    // startAutonomy.mutate({ data: config }, { onSuccess: invalidate });
    alert("Continuous autonomy is currently disabled for safety. Use manual cycles.");
  };

  const handleStop = () => {
    stopAutonomy.mutate(undefined, { onSuccess: invalidate });
  };

  const handlePause = () => {
    pauseAutonomy.mutate(undefined, { onSuccess: invalidate });
  };

  const handleResume = () => {
    resumeAutonomy.mutate(undefined, { onSuccess: invalidate });
  };

  const handleRunNow = () => {
    const idempotencyKey = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
    runCycle.mutate(
      { data: { idempotencyKey, category: 'BUSINESS' } },
      { onSuccess: invalidate }
    );
  };

  const autonomyState = statusQuery.data;
  const isRunning = autonomyState?.status === 'ON';
  const isPaused = autonomyState?.status === 'PAUSED';

  return (
    <div>
      <PageHeader 
        eyebrow="Control Autónomo / 04" 
        title="Motor de Monetización" 
        description="Observabilidad del Director autónomo. La ejecución continua y los ciclos manuales permanecen bloqueados hasta completar la Torre de Control."
        action={
          <div className="flex gap-2">
            <button className="button button-secondary" onClick={() => setFormOpen(!formOpen)} data-testid="button-configure-autonomy">
              <Settings2 size={16} /> Horarios
            </button>
            <button className="button button-primary opacity-50 cursor-not-allowed" disabled title="Bloqueado durante la fase de observabilidad." data-testid="button-run-now">
              <FastForward size={16} /> CICLO MANUAL BLOQUEADO
            </button>
          </div>
        } 
      />

      <div className="launch-panel mb-8" style={{ backgroundColor: isRunning ? 'hsl(var(--sidebar-primary))' : isPaused ? 'hsl(34 74% 55%)' : 'hsl(var(--sidebar))', color: isRunning ? 'hsl(var(--sidebar-primary-foreground))' : 'hsl(var(--sidebar-foreground))' }}>
        <div className="launch-intro flex justify-between items-center w-full relative z-10">
          <div className="flex gap-4 items-center">
            <div className="launch-icon" style={{ backgroundColor: 'transparent', border: '2px solid currentColor' }}>
              <ActivityIcon size={24} />
            </div>
            <div>
              <div className="eyebrow" style={{ color: 'inherit', opacity: 0.7 }}>Estado del Motor (Continúo)</div>
              <h2 style={{ margin: '5px 0' }}>{autonomyState?.status || 'OFF (SEGURO)'}</h2>
              <p style={{ color: 'inherit', opacity: 0.8, maxWidth: '500px' }}>
                 {isRunning ? 'El Director está habilitado, pero la ejecución de dinero real sigue bloqueada.' :
                 isPaused ? 'Motor en pausa.' :
                 'La autonomía continua y la ejecución manual están deshabilitadas durante esta fase de observabilidad.'}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            {!isRunning && !isPaused && (
              <button className="button opacity-50 cursor-not-allowed" style={{ backgroundColor: 'hsl(var(--background))', color: 'hsl(var(--foreground))' }} disabled title="La autonomía continua está deshabilitada." data-testid="button-start-autonomy">
                <Play size={16} /> INICIAR (BLOQUEADO)
              </button>
            )}
            {isRunning && (
              <>
                <button className="button" style={{ backgroundColor: 'rgba(0,0,0,0.1)', color: 'inherit' }} onClick={handlePause} disabled={pauseAutonomy.isPending} data-testid="button-pause-autonomy">
                  <Pause size={16} /> PAUSAR
                </button>
                <button className="button" style={{ backgroundColor: 'hsl(var(--destructive))', color: 'hsl(var(--destructive-foreground))' }} onClick={handleStop} disabled={stopAutonomy.isPending} data-testid="button-stop-autonomy">
                  <StopCircle size={16} /> DETENER
                </button>
              </>
            )}
            {isPaused && (
              <>
                <button className="button opacity-50 cursor-not-allowed" style={{ backgroundColor: 'hsl(var(--background))', color: 'hsl(var(--foreground))' }} disabled data-testid="button-resume-autonomy">
                  <Play size={16} /> REANUDAR (BLOQUEADO)
                </button>
                <button className="button" style={{ backgroundColor: 'hsl(var(--destructive))', color: 'hsl(var(--destructive-foreground))' }} onClick={handleStop} disabled={stopAutonomy.isPending} data-testid="button-stop-autonomy">
                  <StopCircle size={16} /> DETENER
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {formOpen && (
        <div className="panel mb-8 animate-enter">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Ajustes (Simulación)</div>
              <h3>Horarios de ejecución teórica</h3>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <label className="field">
              <span>Zona Horaria</span>
              <input value={config.timezone} onChange={e => setConfig({...config, timezone: e.target.value})} placeholder="Ej. America/Los_Angeles" />
            </label>
            <label className="field">
              <span>Slots Diarios (HH:MM, separados por coma)</span>
              <input value={config.dailySlots?.join(',')} onChange={e => setConfig({...config, dailySlots: e.target.value.split(',').map(s => s.trim())})} />
            </label>
          </div>
          <div className="mt-4">
            <button className="button button-secondary" onClick={() => setFormOpen(false)}>Cerrar</button>
          </div>
        </div>
      )}

      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Trazabilidad</div>
              <h3>Ciclos Autónomos</h3>
            </div>
          </div>
          <DataState loading={cyclesQuery.isLoading} error={!!cyclesQuery.error} empty={!cyclesQuery.isLoading && (cyclesQuery.data?.length === 0)} onRetry={() => void cyclesQuery.refetch()}>
            <div className="opportunity-list">
              {(cyclesQuery.data || []).map(cycle => (
                <div key={cycle.id} className="opportunity-card">
                  <div className="opportunity-top">
                    <span className="record-id">CYC-A-{String(cycle.id).padStart(4, '0')}</span>
                    <Badge value={cycle.state} small />
                    <span className="card-date">{formatDate(cycle.createdAt)} {formatTime(cycle.createdAt)}</span>
                  </div>
                  <div className="py-4">
                    <h3 className="text-sm font-semibold mb-1">{cycle.category} - {statusLabel(cycle.stage)}</h3>
                    <p className="text-xs text-muted-foreground">{cycle.message}</p>
                  </div>
                  <div className="opportunity-bottom">
                    <span><b>Checkpoint</b>{cycle.checkpoint}</span>
                    {cycle.opportunityId && <span><b>Oportunidad</b>#{cycle.opportunityId}</span>}
                    {cycle.score && <span><b>Score</b>{cycle.score}</span>}
                  </div>
                </div>
              ))}
            </div>
          </DataState>
        </section>

        <section className="panel activity-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Operaciones recientes</div>
              <h3>Actividad del Motor</h3>
            </div>
          </div>
          <DataState loading={activityQuery.isLoading} error={!!activityQuery.error} empty={!activityQuery.isLoading && (activityQuery.data?.length === 0)} onRetry={() => void activityQuery.refetch()}>
            <div className="activity-list activity-compact">
              {(activityQuery.data || []).map((activity, index) => (
                <div className="activity-row" key={`${activity.id || index}-${activity.createdAt}`}>
                  <div className={cx('activity-marker', statusTone(activity.state))}><span /></div>
                  <div className="activity-body">
                    <div className="activity-meta">
                      <strong>{activity.stage || 'Sistema'}</strong>
                      <span>{formatTime(activity.createdAt)}</span>
                    </div>
                    <p>{activity.message}</p>
                  </div>
                </div>
              ))}
            </div>
          </DataState>
        </section>
      </div>
    </div>
  );
}