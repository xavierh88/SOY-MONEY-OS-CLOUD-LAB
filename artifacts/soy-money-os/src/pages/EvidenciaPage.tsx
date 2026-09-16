import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, ShieldCheck, AlertTriangle, RefreshCw } from 'lucide-react';
import {
  getListEvidenceQueryKey,
  useListEvidence,
  useTransitionEvidence,
} from '@workspace/api-client-react';
import { PageHeader, DataState, Badge, formatDate } from '@/App';

type EvidenceAction =
  | 'MANUAL_VERIFICATION'
  | 'MANUAL_CONTRADICTION'
  | 'MANUAL_CORRECTION'
  | 'MARK_FRESH'
  | 'MARK_STALE';

type EvidenceStatus =
  | 'NOT_VERIFIED'
  | 'REAL_VERIFIED'
  | 'CONTRADICTED'
  | 'EXPIRED';

export default function EvidenciaPage() {
  const queryClient = useQueryClient();
  const evidenceQuery = useListEvidence();
  const transition = useTransitionEvidence();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [freshnessScore, setFreshnessScore] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const selected = useMemo(
    () => (evidenceQuery.data || []).find((item) => item.id === selectedId) ?? null,
    [evidenceQuery.data, selectedId],
  );

  const runTransition = (
    action: EvidenceAction,
    toStatus: EvidenceStatus,
  ) => {
    if (!selected) return;

    const cleanReason = reason.trim();

    if (!cleanReason) {
      setMessage('Debes escribir el motivo de la acción humana.');
      return;
    }

    let parsedFreshness: number | undefined;

    if (freshnessScore.trim() !== '') {
      parsedFreshness = Number(freshnessScore);

      if (
        !Number.isInteger(parsedFreshness) ||
        parsedFreshness < 0 ||
        parsedFreshness > 100
      ) {
        setMessage('La frescura debe ser un número entero entre 0 y 100.');
        return;
      }
    }

    setMessage(null);

    transition.mutate(
      {
        id: selected.id,
        data: {
          action,
          toStatus,
          reason: cleanReason,
          provenance: {
            actor: 'OWNER',
            interface: 'P1_EVIDENCE_UI',
            manual: true,
            evidenceId: selected.id,
            opportunityId: selected.opportunityId,
          },
          ...(parsedFreshness !== undefined
            ? { freshnessScore: parsedFreshness }
            : {}),
        },
      },
      {
        onSuccess: () => {
          setMessage(
            `EV-${String(selected.id).padStart(3, '0')}: acción ${action} registrada correctamente.`,
          );
          setReason('');
          setFreshnessScore('');
          queryClient.invalidateQueries({
            queryKey: getListEvidenceQueryKey(),
          });
        },
        onError: (error) => {
          setMessage(
            error instanceof Error
              ? error.message
              : 'No se pudo registrar la transición de evidencia.',
          );
        },
      },
    );
  };

  return (
    <div>
      <PageHeader
        eyebrow="Trazabilidad / Evidencia"
        title="Evidencia"
        description="Revisa las fuentes y aplica únicamente transiciones humanas explícitas. Ninguna evidencia se convierte automáticamente en REAL_VERIFIED."
        action={
          <div className="legend">
            <Badge value="NOT_VERIFIED" small />
            <Badge value="REAL_VERIFIED" small />
            <Badge value="CONTRADICTED" small />
            <Badge value="EXPIRED" small />
          </div>
        }
      />

      {message && (
        <div className="panel mb-4 text-sm" role="status">
          {message}
        </div>
      )}

      <DataState
        loading={evidenceQuery.isLoading}
        error={!!evidenceQuery.error}
        errorDetail={
          evidenceQuery.error instanceof Error
            ? evidenceQuery.error.message
            : undefined
        }
        empty={!evidenceQuery.isLoading && !evidenceQuery.data?.length}
        onRetry={() => void evidenceQuery.refetch()}
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
          <section className="panel">
            <div className="panel-heading border-b pb-4 mb-4">
              <div>
                <div className="eyebrow">REGISTROS</div>
                <h3>Evidencia recopilada ({evidenceQuery.data?.length || 0})</h3>
              </div>
            </div>

            <div className="opportunity-list">
              {(evidenceQuery.data || []).map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => {
                    setSelectedId(item.id);
                    setMessage(null);
                    setReason('');
                    setFreshnessScore(
                      item.freshnessScore == null
                        ? ''
                        : String(item.freshnessScore),
                    );
                  }}
                  className="opportunity-card text-left w-full"
                  style={
                    selectedId === item.id
                      ? { borderColor: 'hsl(var(--sidebar-primary))' }
                      : undefined
                  }
                  data-testid={`evidence-select-${item.id}`}
                >
                  <div className="opportunity-top">
                    <span className="record-id">
                      EV-{String(item.id).padStart(3, '0')}
                    </span>
                    <Badge value={item.verificationStatus} small />
                    <span className="card-date">
                      {formatDate(item.collectedAt)}
                    </span>
                  </div>

                  <div className="py-3">
                    <strong>Oportunidad #{item.opportunityId}</strong>
                    <p className="text-sm mt-2">{item.claim}</p>

                    <div className="flex flex-wrap gap-2 mt-3 text-xs text-muted-foreground">
                      <span>{item.source}</span>
                      <span>•</span>
                      <span>{item.proofType}</span>
                      <span>•</span>
                      <span>Frescura {item.freshnessScore ?? '—'}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <aside className="panel">
            {!selected ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                Selecciona una evidencia para revisar su trazabilidad y realizar
                una acción humana.
              </div>
            ) : (
              <div>
                <div className="panel-heading border-b pb-4 mb-4">
                  <div>
                    <div className="eyebrow">REVISIÓN HUMANA</div>
                    <h3>EV-{String(selected.id).padStart(3, '0')}</h3>
                  </div>
                  <Badge value={selected.verificationStatus} />
                </div>

                <div className="grid gap-4 text-sm">
                  <div>
                    <strong>Fuente</strong>
                    <p className="text-muted-foreground mt-1">
                      {selected.source}
                    </p>
                  </div>

                  <div>
                    <strong>Afirmación</strong>
                    <p className="text-muted-foreground mt-1">
                      {selected.claim}
                    </p>
                  </div>

                  <div>
                    <strong>URL</strong>
                    <p className="mt-1 break-all">
                      <a
                        href={selected.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-link inline-flex items-center gap-1"
                      >
                        {selected.url}
                        <ExternalLink size={12} />
                      </a>
                    </p>
                  </div>

                  <div>
                    <strong>Clasificación</strong>
                    <p className="text-muted-foreground mt-1">
                      {selected.proofType}
                    </p>
                  </div>

                  <div>
                    <strong>Contradicciones</strong>
                    <p className="text-muted-foreground mt-1">
                      {selected.contradictions?.length
                        ? selected.contradictions.join(' · ')
                        : 'Ninguna registrada'}
                    </p>
                  </div>

                  <div>
                    <strong>Gaps</strong>
                    <p className="text-muted-foreground mt-1">
                      {selected.gaps?.length
                        ? selected.gaps.join(' · ')
                        : 'Ninguno registrado'}
                    </p>
                  </div>

                  <div>
                    <strong>Provenance / referencia</strong>
                    <p className="text-muted-foreground mt-1 break-all">
                      {selected.evidenceRef || 'Sin referencia adicional'}
                    </p>
                    <p className="text-muted-foreground mt-1 break-all">
                      Independencia: {selected.independenceKey || '—'}
                    </p>
                  </div>

                  <label className="grid gap-2">
                    <strong>Motivo obligatorio</strong>
                    <textarea
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="Explica por qué realizas esta acción..."
                      className="min-h-24 w-full rounded-md border border-border bg-background p-3 text-sm"
                      data-testid="evidence-reason"
                    />
                  </label>

                  <label className="grid gap-2">
                    <strong>Frescura 0–100 (opcional)</strong>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      value={freshnessScore}
                      onChange={(event) =>
                        setFreshnessScore(event.target.value)
                      }
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      data-testid="evidence-freshness"
                    />
                  </label>

                  <div className="grid gap-2 pt-2">
                    <button
                      type="button"
                      className="button button-primary w-full justify-center"
                      disabled={transition.isPending}
                      onClick={() =>
                        runTransition(
                          'MANUAL_VERIFICATION',
                          'REAL_VERIFIED',
                        )
                      }
                      data-testid="evidence-verify"
                    >
                      <ShieldCheck size={15} />
                      Verificar manualmente
                    </button>

                    <button
                      type="button"
                      className="button button-secondary w-full justify-center"
                      disabled={transition.isPending}
                      onClick={() =>
                        runTransition(
                          'MANUAL_CONTRADICTION',
                          'CONTRADICTED',
                        )
                      }
                      data-testid="evidence-contradict"
                    >
                      <AlertTriangle size={15} />
                      Marcar contradicción
                    </button>

                    <button
                      type="button"
                      className="button button-secondary w-full justify-center"
                      disabled={transition.isPending}
                      onClick={() =>
                        runTransition(
                          'MANUAL_CORRECTION',
                          'NOT_VERIFIED',
                        )
                      }
                      data-testid="evidence-correct"
                    >
                      <RefreshCw size={15} />
                      Corregir a no verificada
                    </button>

                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        className="button button-secondary justify-center"
                        disabled={transition.isPending}
                        onClick={() =>
                          runTransition(
                            'MARK_FRESH',
                            selected.verificationStatus === 'EXPIRED'
                              ? 'NOT_VERIFIED'
                              : (selected.verificationStatus as EvidenceStatus),
                          )
                        }
                        data-testid="evidence-fresh"
                      >
                        Marcar fresca
                      </button>

                      <button
                        type="button"
                        className="button button-secondary justify-center"
                        disabled={transition.isPending}
                        onClick={() =>
                          runTransition('MARK_STALE', 'EXPIRED')
                        }
                        data-testid="evidence-stale"
                      >
                        Marcar expirada
                      </button>
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    REAL_VERIFIED solo se solicita mediante una acción humana
                    MANUAL_VERIFICATION. El servidor vuelve a validar la
                    transición antes de persistirla.
                  </p>
                </div>
              </div>
            )}
          </aside>
        </div>
      </DataState>
    </div>
  );
}
