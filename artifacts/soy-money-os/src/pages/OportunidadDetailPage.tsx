import { useState } from 'react';
import { useParams, Link } from 'wouter';
import { ArrowLeft, BrainCircuit, BarChart3, Layers3, ShieldCheck, AlertTriangle, Clock3, RotateCcw } from 'lucide-react';
import { useGetControlTowerOpportunity, useTransitionEvidence } from '@workspace/api-client-react';
import { PageHeader, DataState, Badge, formatDate, formatTime, cx, statusTone } from '@/App';

function Info({ label, value }: { label: string; value?: string | null }) { return <div className="info-block"><span>{label}</span><p>{value || 'No disponible'}</p></div>; }
function Fact({ label, value }: { label: string; value?: string | number | null }) { return <div className="fact"><span>{label}</span><strong>{value ?? 'No disponible'}</strong></div>; }
function economicClass(result: { realRevenue: boolean; resultType: string }) {
  if (result.realRevenue) return 'REAL';
  return /PAPER|SIMULAT|TEST/i.test(result.resultType) ? 'SIMULATED' : 'POTENTIAL';
}

type EvidenceAction = 'MANUAL_CORRECTION' | 'MANUAL_VERIFICATION' | 'MANUAL_CONTRADICTION' | 'MARK_FRESH' | 'MARK_STALE';
type EvidenceStatus = 'NOT_VERIFIED' | 'REAL_VERIFIED' | 'CONTRADICTED' | 'EXPIRED';

export default function OportunidadDetailPage() {
  const params = useParams<{ id?: string }>();
  const id = Number(params.id || 0);
  const opp = useGetControlTowerOpportunity(id);
  const transition = useTransitionEvidence();
  const [tab, setTab] = useState<'overview' | 'evidence' | 'activity'>('overview');
  const [editingEvidenceId, setEditingEvidenceId] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [freshnessScore, setFreshnessScore] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const d = opp.data;

  async function applyEvidenceAction(evidenceId: number, action: EvidenceAction, toStatus: EvidenceStatus) {
    const cleanReason = reason.trim();
    if (!cleanReason) {
      setFeedback('Debes escribir el motivo humano antes de cambiar una evidencia.');
      return;
    }
    const parsedFreshness = freshnessScore === '' ? undefined : Number(freshnessScore);
    if (parsedFreshness !== undefined && (!Number.isFinite(parsedFreshness) || parsedFreshness < 0 || parsedFreshness > 100)) {
      setFeedback('Freshness debe estar entre 0 y 100.');
      return;
    }
    setFeedback(null);
    try {
      await transition.mutateAsync({
        id: evidenceId,
        data: {
          action,
          toStatus,
          reason: cleanReason,
          provenance: {
            actor: 'OWNER',
            interface: 'OPPORTUNITY_EVIDENCE_UI',
            opportunityId: id,
            explicitHumanAction: true,
          },
          ...(parsedFreshness === undefined ? {} : { freshnessScore: parsedFreshness }),
        },
      });
      setFeedback(`Evidencia #${evidenceId} actualizada mediante acción humana explícita.`);
      setEditingEvidenceId(null);
      setReason('');
      setFreshnessScore('');
      await opp.refetch();
    } catch {
      setFeedback('La transición fue rechazada o hubo un conflicto. Recarga la evidencia y vuelve a intentarlo.');
    }
  }

  return (
    <div>
      <Link href="/oportunidades" className="back-link"><ArrowLeft size={14} /> Volver a inventario</Link>
      <DataState loading={opp.isLoading} error={!!opp.error} empty={!opp.isLoading && !d} onRetry={() => void opp.refetch()}>
        {d && <>
          <PageHeader eyebrow={`Oportunidad / OP-${String(d.opportunity.id).padStart(4, '0')}`} title={d.opportunity.name} description={d.opportunity.description}
            action={<div className="flex gap-2"><Badge value={d.presentationStatus} />{d.executable && <Badge value="EJECUTABLE" />}</div>} />
          <div className="detail-grid">
            <div className="detail-primary">
              <div className="detail-score"><div className="score-ring"><strong>{d.opportunity.score}</strong><span>SCORE</span></div><div><div className="eyebrow">Clasificación</div><h3>{d.opportunity.sector}</h3><p>{d.opportunity.timeToRevenue} · {d.opportunity.difficulty} · Riesgo {d.opportunity.risk}</p></div></div>
              <div className="tab-bar mt-4">
                <button className={cx(tab === 'overview' && 'tab-active')} onClick={() => setTab('overview')}>Hipótesis</button>
                <button className={cx(tab === 'evidence' && 'tab-active')} onClick={() => setTab('evidence')}>Evidencia <span>{d.evidence.length}</span></button>
                <button className={cx(tab === 'activity' && 'tab-active')} onClick={() => setTab('activity')}>Actividad <span>{d.activity.length}</span></button>
              </div>
              {tab === 'overview' && <div className="hypothesis-grid animate-enter"><Info label="Problema a resolver" value={d.opportunity.problem} /><Info label="Cliente objetivo" value={d.opportunity.targetCustomer} /><Info label="Solución propuesta" value={d.opportunity.proposedSolution} /><Info label="Método de monetización" value={d.opportunity.monetizationMethod} /></div>}
              {tab === 'evidence' && <div className="evidence-list animate-enter">
                <div className="p-4 mb-4 rounded border border-border bg-secondary/30 text-sm">
                  <strong>Control humano de evidencia.</strong> Search Evidence no equivale a Demand Proof. REAL_VERIFIED solo puede asignarse aquí mediante una verificación humana explícita, con motivo y procedencia auditables. Ninguna acción de esta pantalla crea Demand Proof automáticamente.
                </div>
                {feedback && <div className="p-3 mb-4 rounded border border-border text-sm">{feedback}</div>}
                {d.evidence.length === 0 ? <p className="text-sm text-muted-foreground p-8">No hay evidencias recolectadas para esta oportunidad.</p> : d.evidence.map(e => (
                  <div key={e.id} className="evidence-item p-4 border border-border mb-4 rounded bg-card">
                    <div className="flex gap-4"><div className="bg-secondary p-2 rounded self-start"><Badge value={e.proofType} small /></div><div className="flex-1">
                      <div className="flex flex-wrap gap-2 mb-2"><Badge value={e.verificationStatus} small />{e.freshnessScore != null && <Badge value={`FRESH ${e.freshnessScore}`} small />}</div>
                      <h4 className="text-sm font-semibold mb-2 italic">"{e.claim}"</h4>
                      <div className="text-xs text-muted-foreground mb-3">Fuente: {e.source} · {formatDate(e.collectedAt)}{e.independenceKey && <> · Origen: {e.independenceKey}</>}{e.url && <a href={e.url} target="_blank" rel="noreferrer" className="text-accent ml-2 underline">Ver fuente</a>}</div>
                      {e.contradictions?.length > 0 && <div className="mb-2"><strong className="text-xs text-destructive">Contradicciones:</strong><ul className="list-disc pl-4 text-xs text-muted-foreground">{e.contradictions.map((c, i) => <li key={i}>{c}</li>)}</ul></div>}
                      {e.gaps?.length > 0 && <div className="mb-3"><strong className="text-xs text-accent">Gaps de información:</strong><ul className="list-disc pl-4 text-xs text-muted-foreground">{e.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul></div>}
                      <button className="button-small" onClick={() => { setEditingEvidenceId(editingEvidenceId === e.id ? null : e.id); setReason(''); setFreshnessScore(e.freshnessScore == null ? '' : String(e.freshnessScore)); setFeedback(null); }}>Revisar evidencia</button>
                      {editingEvidenceId === e.id && <div className="mt-4 p-4 border border-border rounded bg-secondary/20">
                        <label className="text-xs font-bold block mb-1">Motivo humano obligatorio</label>
                        <textarea className="w-full min-h-20 p-2 rounded border border-border bg-background text-sm" value={reason} onChange={ev => setReason(ev.target.value)} placeholder="Explica qué comprobaste, corregiste o contradice esta fuente." />
                        <label className="text-xs font-bold block mt-3 mb-1">Freshness 0–100 (opcional)</label>
                        <input className="w-full p-2 rounded border border-border bg-background text-sm" type="number" min="0" max="100" value={freshnessScore} onChange={ev => setFreshnessScore(ev.target.value)} />
                        <div className="flex flex-wrap gap-2 mt-3">
                          <button disabled={transition.isPending} className="button-small" onClick={() => void applyEvidenceAction(e.id, 'MANUAL_VERIFICATION', 'REAL_VERIFIED')}><ShieldCheck size={13} /> Verificación humana</button>
                          <button disabled={transition.isPending} className="button-small" onClick={() => void applyEvidenceAction(e.id, 'MANUAL_CONTRADICTION', 'CONTRADICTED')}><AlertTriangle size={13} /> Marcar contradicción</button>
                          <button disabled={transition.isPending} className="button-small" onClick={() => void applyEvidenceAction(e.id, 'MANUAL_CORRECTION', 'NOT_VERIFIED')}><RotateCcw size={13} /> Corregir a no verificada</button>
                          <button disabled={transition.isPending} className="button-small" onClick={() => void applyEvidenceAction(e.id, 'MARK_STALE', 'EXPIRED')}><Clock3 size={13} /> Marcar vencida</button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-3">Las acciones son persistentes, auditables y pueden ser rechazadas por el backend si la transición no es válida o la evidencia cambió concurrentemente.</p>
                      </div>}
                    </div></div>
                  </div>
                ))}
              </div>}
              {tab === 'activity' && <div className="p-6 animate-enter"><div className="activity-list">{d.activity.length === 0 ? <p className="text-sm text-muted-foreground">Sin actividad registrada.</p> : d.activity.map(a => <div className="activity-row" key={a.id}><div className={cx('activity-marker', statusTone(a.status))}><span /></div><div className="activity-body"><div className="activity-meta"><strong>{a.stage}</strong><span>{formatDate(a.createdAt)} {formatTime(a.createdAt)}</span></div><p className="text-sm my-2">{a.message}</p><Badge value={a.status} small /></div></div>)}</div></div>}
            </div>
            <div className="detail-aside">
              <section className="panel p-5 bg-card border border-border"><h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-4">Metadatos de Señal</h3><div className="flex flex-col gap-3"><Fact label="Validez temporal" value={d.opportunity.expiresAt ? (new Date(d.opportunity.expiresAt) > new Date() ? 'ACTIVA' : 'EXPIRADA') : 'No disponible'} /><Fact label="Detectada" value={formatDate(d.opportunity.detectedAt)} /><Fact label="Válida desde" value={formatDate(d.opportunity.validFrom)} /><Fact label="Válida hasta" value={formatDate(d.opportunity.validUntil)} /><Fact label="Expira" value={formatDate(d.opportunity.expiresAt)} /><Fact label="Motivo de expiración" value={d.opportunity.expirationReason} /></div>{d.metadata && <div className="mt-6 border-t border-border pt-4"><h4 className="text-xs font-bold mb-3">Score Breakdown</h4><div className="flex flex-col gap-2 font-mono text-xs">{Object.entries(d.metadata.scoreBreakdown).map(([k, v]) => <div key={k} className="flex justify-between"><span className="text-muted-foreground">{k.replace('_', ' ')}</span><strong>{Number(v).toFixed(1)}</strong></div>)}</div></div>}</section>
              {d.projects.length > 0 && <section className="panel p-5 bg-card border border-border"><h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-4 flex items-center gap-2"><Layers3 size={14} /> Proyectos Vinculados</h3><div className="flex flex-col gap-3">{d.projects.map(p => <Link href={`/proyectos/${p.id}`} key={p.id} className="block p-3 border border-border rounded hover:border-foreground/30 transition-colors"><strong className="block text-sm mb-1">{p.name}</strong><Badge value={p.status} small /></Link>)}</div></section>}
              {d.results.length > 0 && <section className="panel p-5 bg-card border border-border"><h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-4 flex items-center gap-2"><BarChart3 size={14} /> Resultados</h3><div className="flex flex-col gap-3">{d.results.map(r => <div key={r.id} className="p-3 border border-border rounded"><div className="flex justify-between items-center mb-1"><strong className="text-sm">{r.resultType}</strong><span className="font-mono text-sm">${r.revenue.toFixed(2)}</span></div><p className="text-xs text-muted-foreground mb-2">{r.outcome}</p><div className="flex gap-2"><Badge value={economicClass(r)} small /><Badge value={r.status} small /></div></div>)}</div></section>}
              {d.learning.length > 0 && <section className="panel p-5 bg-card border border-border"><h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-4 flex items-center gap-2"><BrainCircuit size={14} /> Aprendizajes</h3><div className="flex flex-col gap-3">{d.learning.map(l => <div key={l.id} className="p-3 border border-border rounded bg-secondary/30"><strong className="block text-sm mb-1">{l.title}</strong><p className="text-xs text-muted-foreground">{l.summary}</p></div>)}</div></section>}
            </div>
          </div>
        </>}
      </DataState>
    </div>
  );
}
