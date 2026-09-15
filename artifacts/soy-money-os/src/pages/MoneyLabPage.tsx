import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Play, RefreshCw, CircleAlert, Radar, FileSearch, ShieldCheck, X, ChevronDown, ChevronUp } from 'lucide-react';
import { 
  useGetMoneyLabSummary, 
  useListMarketCycles, 
  useStartMarketCycle, 
  getGetMoneyLabSummaryQueryKey, 
  getListMarketCyclesQueryKey,
  useListMarketCycleCandidates,
  getListMarketCycleCandidatesQueryKey
} from '@workspace/api-client-react';
import { PageHeader, DataState, MetricCard, Badge, statusLabel, formatDate, formatTime, cx } from '@/App';

function marketClassification(status?: string) {
  if (status === 'PAPER_APPROVED') return 'POTENCIAL: Evidencia simulada encontrada, verificación real pendiente.';
  if (status === 'REJECTED') return 'DESCARTADO: Evidencia insuficiente durante la simulación histórica.';
  if (status === 'QUEUED' || status === 'RUNNING') return 'EN PROGRESO: Descubrimiento y simulación en GitHub Actions.';
  if (status === 'FAILED') return 'ERROR: Fallo en la integración del laboratorio.';
  return 'COMPLETADO: Ciclo finalizado sin señales aprobadas.';
}

export default function MoneyLabPage() {
  const queryClient = useQueryClient();
  const summary = useGetMoneyLabSummary({
    query: {
      queryKey: getGetMoneyLabSummaryQueryKey(),
      refetchInterval: (query) => {
        const status = query.state.data?.latestCycle?.status;
        return status === 'QUEUED' || status === 'RUNNING' ? 3000 : false;
      },
    },
  });
  const history = useListMarketCycles({
    query: {
      queryKey: getListMarketCyclesQueryKey(),
      refetchInterval: (query) => {
        const latest = query.state.data?.[0]?.status;
        return latest === 'QUEUED' || latest === 'RUNNING' ? 3000 : false;
      },
    },
  });
  const start = useStartMarketCycle();
  const latest = summary.data?.latestCycle;
  const active = latest?.status === 'QUEUED' || latest?.status === 'RUNNING';
  const connectionRequired = summary.data?.connectionStatus === 'GITHUB_CONNECTION_REQUIRED';

  const [selectedCycleId, setSelectedCycleId] = useState<number | null>(null);
  
  useEffect(() => {
    if (latest?.id && selectedCycleId === null) setSelectedCycleId(latest.id);
  }, [latest?.id, selectedCycleId]);

  const candidatesQuery = useListMarketCycleCandidates(selectedCycleId ?? 0, {
    query: {
      enabled: !!selectedCycleId,
      queryKey: getListMarketCycleCandidatesQueryKey(selectedCycleId ?? 0),
    }
  });

  const runNow = () => {
    const idempotencyKey = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
    start.mutate({ data: { idempotencyKey } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetMoneyLabSummaryQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListMarketCyclesQueryKey() });
      },
    });
  };
  const candidateCounts = useMemo(() => {
    const rows = candidatesQuery.data || [];
    return {
      candidates: rows.filter((row) => row.gate === 'PAPER_CANDIDATE').length,
      discarded: rows.filter((row) => row.gate === 'NO_VALID_OPPORTUNITY').length,
    };
  }, [candidatesQuery.data]);

  return <div>
    <PageHeader 
      eyebrow="Laboratorio cuantitativo / 09" 
      title="Market Lab" 
      description="Investigación histórica y simulación en GitHub Actions. Ningún resultado de este laboratorio usa dinero real ni constituye evidencia REAL_VERIFIED." 
      action={<button className="button button-primary" onClick={runNow} disabled={start.isPending || active || connectionRequired} data-testid="button-run-market-cycle">
        {start.isPending ? <RefreshCw size={15} className="spin" /> : <Play size={15} />}
        {start.isPending ? 'INICIANDO' : 'EJECUTAR CICLO AHORA'}
      </button>} 
    />

    {connectionRequired && <div className="proof-banner money-lab-warning" data-testid="github-connection-required">
      <CircleAlert size={22} />
      <div><strong>GITHUB_CONNECTION_REQUIRED</strong><p>Falta la autorización segura de GitHub. El resto de SOY MONEY OS y Windmill continúan funcionando.</p></div>
    </div>}

    <div className="money-lab-guardrail mb-8 flex gap-4 text-xs font-mono text-muted-foreground p-4 bg-secondary border border-border rounded">
      <Badge value="PAPER / SIMULATION" />
      <span>real_money_used = false</span>
      <span>financial_execution = false</span>
      <span>real_verified = false</span>
    </div>

    <div className="metric-grid mb-8">
      <MetricCard label="Mercados analizados" value={summary.data?.marketsAnalyzed ?? '—'} note="series históricas procesadas" icon={Radar} tone="blue" />
      <MetricCard label="Candidatos encontrados" value={summary.data?.candidatesFound ?? '—'} note="señales de investigación" icon={FileSearch} tone="amber" />
      <MetricCard label="Paper approved" value={summary.data?.paperApproved ?? '—'} note="simulación, no verificación real" icon={ShieldCheck} tone="lime" />
      <MetricCard label="Descartados" value={summary.data?.rejected ?? '—'} note={`${summary.data?.failed ?? 0} ciclos fallidos`} icon={X} tone="coral" />
    </div>

    <div className="dashboard-grid">
      <div className="flex flex-col gap-6">
        <section className="panel money-lab-current">
          <div className="panel-heading"><div><div className="eyebrow">ÚLTIMO CICLO</div><h3>SOY Autonomous Market Cycle V1</h3></div><Badge value={latest?.status || 'SIN DATOS'} /></div>
          <DataState loading={summary.isLoading} error={!!summary.error} empty={!summary.isLoading && !latest} onRetry={() => void summary.refetch()}>
            {latest && <div className="grid grid-cols-2 gap-4 text-sm mb-4">
              <div><span className="block text-muted-foreground text-xs uppercase mb-1">Estado</span><strong>{statusLabel(latest.status)}</strong></div>
              <div><span className="block text-muted-foreground text-xs uppercase mb-1">Clasificación</span><strong>{marketClassification(latest.status)}</strong></div>
              <div><span className="block text-muted-foreground text-xs uppercase mb-1">Última ejecución</span><strong>{formatDate(latest.startedAt)} · {formatTime(latest.startedAt)}</strong></div>
              <div><span className="block text-muted-foreground text-xs uppercase mb-1">Próximo ciclo</span><strong>{summary.data?.nextScheduledCycle ? `${formatDate(summary.data.nextScheduledCycle)} · ${formatTime(summary.data.nextScheduledCycle)}` : 'No calculado'}</strong></div>
              <div><span className="block text-muted-foreground text-xs uppercase mb-1">Run ID</span><strong>{latest.githubRunId || 'Pendiente de GitHub'}</strong></div>
              <div><span className="block text-muted-foreground text-xs uppercase mb-1">Origen</span><strong>{latest.source}</strong></div>
            </div>}
            {latest?.errors?.length ? <div className="p-3 border border-[hsl(var(--destructive)/0.5)] bg-[hsl(var(--destructive)/0.1)] rounded text-sm text-[hsl(var(--destructive))]"><strong>Errores reales:</strong> {latest.errors.join(' · ')}</div> : null}
            {active && <div className="mt-4 flex items-center gap-3 text-sm text-accent"><span className="pulse-dot bg-accent" /><strong>{latest.status === 'QUEUED' ? 'En cola de GitHub Actions' : 'Investigación y validación en progreso'}</strong></div>}
            {latest?.result && <details className="mt-4"><summary className="text-sm cursor-pointer text-muted-foreground hover:text-foreground">Ver resultado persistido</summary><pre className="mt-2 text-xs font-mono bg-secondary p-4 rounded overflow-x-auto">{JSON.stringify(latest.result, null, 2)}</pre></details>}
          </DataState>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">REGISTROS INDIVIDUALES DEL CICLO</div>
              <h3>Análisis persistidos (ML-{String(selectedCycleId || 0).padStart(4, '0')})</h3>
              <p className="text-xs text-muted-foreground mt-1">
                {candidateCounts.candidates} candidatos · {candidateCounts.discarded} descartados
              </p>
            </div>
          </div>
          <DataState loading={candidatesQuery.isLoading} error={!!candidatesQuery.error} empty={!candidatesQuery.isLoading && (!candidatesQuery.data || candidatesQuery.data.length === 0)} onRetry={() => void candidatesQuery.refetch()}>
            <div className="flex flex-col gap-4">
              {(candidatesQuery.data || []).map(candidate => (
                <CandidateRow key={candidate.id} candidate={candidate} />
              ))}
            </div>
          </DataState>
        </section>
      </div>

      <section className="panel money-lab-history">
        <div className="panel-heading"><div><div className="eyebrow">TRAZABILIDAD</div><h3>Historial de ciclos</h3></div><span className="muted-text">{summary.data?.totalCycles ?? 0} REGISTROS</span></div>
        <DataState loading={history.isLoading} error={!!history.error} empty={!history.isLoading && !history.data?.length} onRetry={() => void history.refetch()}>
          <div className="flex flex-col gap-2">
            {(history.data || []).map((cycle) => (
              <button 
                key={cycle.id} 
                onClick={() => setSelectedCycleId(cycle.id)}
                className={cx("text-left p-3 border rounded transition-colors text-sm", selectedCycleId === cycle.id ? "bg-accent/10 border-accent" : "bg-card border-border hover:border-foreground/30")}
              >
                <div className="flex justify-between items-center mb-2">
                  <strong className="font-mono text-xs">ML-{String(cycle.id).padStart(4, '0')}</strong>
                  <Badge value={cycle.status} small />
                </div>
                <div className="text-xs text-muted-foreground">
                  {cycle.marketsAnalyzed} analizados · {cycle.paperApproved} aprobados
                </div>
                <div className="text-[10px] text-muted-foreground mt-2">
                  {formatDate(cycle.startedAt)} {formatTime(cycle.startedAt)}
                </div>
              </button>
            ))}
          </div>
        </DataState>
      </section>
    </div>
  </div>;
}

function CandidateRow({ candidate }: { candidate: any }) {
  const [expanded, setExpanded] = useState(false);
  
  return (
    <div className="border border-border rounded bg-card overflow-hidden">
      <div 
        className="p-4 flex items-center justify-between cursor-pointer hover:bg-secondary/50"
        onClick={() => setExpanded(!expanded)}
      >
        <div>
          <div className="flex items-center gap-3 mb-1">
            <strong className="font-mono text-sm">{candidate.symbol || 'No disponible'}</strong>
            <Badge value={candidate.gate || 'No disponible'} small />
          </div>
          <div className="text-xs text-muted-foreground">
            Estrategia: {candidate.strategyKind || 'No disponible'} · Timestamp: {candidate.cycleTimestamp ? formatDate(candidate.cycleTimestamp) : 'No disponible'}
          </div>
        </div>
        <div className="text-muted-foreground">
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </div>
      
      {expanded && (
        <div className="p-4 border-t border-border bg-secondary/30">
          <div className="mb-4 p-3 bg-secondary border border-border rounded font-mono text-[10px] text-muted-foreground grid grid-cols-3 gap-2">
            <div>
              <span className="block mb-1 opacity-70">REAL_MONEY_USED</span>
              <strong style={{ color: candidate.guardrails.realMoneyUsed ? 'hsl(var(--destructive))' : 'inherit' }}>
                {candidate.guardrails.realMoneyUsed ? 'TRUE' : 'FALSE'}
              </strong>
            </div>
            <div>
              <span className="block mb-1 opacity-70">FINANCIAL_EXECUTION</span>
              <strong style={{ color: candidate.guardrails.financialExecution ? 'hsl(var(--destructive))' : 'inherit' }}>
                {candidate.guardrails.financialExecution ? 'TRUE' : 'FALSE'}
              </strong>
            </div>
            <div>
              <span className="block mb-1 opacity-70">REAL_VERIFIED</span>
              <strong style={{ color: candidate.guardrails.realVerified ? 'hsl(var(--destructive))' : 'inherit' }}>
                {candidate.guardrails.realVerified ? 'TRUE' : 'FALSE'}
              </strong>
            </div>
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div>
              <strong className="block text-xs uppercase mb-2">Procedencia (Provenance)</strong>
              <pre className="text-[10px] font-mono bg-card p-3 rounded border border-border whitespace-pre-wrap">
                {JSON.stringify(candidate.provenance || 'No disponible', null, 2)}
              </pre>
            </div>
            <div>
              <strong className="block text-xs uppercase mb-2">Métricas Brutas</strong>
              <pre className="text-[10px] font-mono bg-card p-3 rounded border border-border whitespace-pre-wrap max-h-48 overflow-y-auto">
                {JSON.stringify(candidate.metrics || 'No disponible', null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
