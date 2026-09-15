import { useParams, Link } from 'wouter';
import { ArrowLeft, CheckCircle2, CircleAlert, FileSearch, ActivityIcon } from 'lucide-react';
import { useGetControlTowerProject } from '@workspace/api-client-react';
import { PageHeader, DataState, Badge, formatDate, cx } from '@/App';

export default function ProyectoDetailPage() {
  const params = useParams<{ id?: string }>();
  const id = Number(params.id || 0);
  const project = useGetControlTowerProject(id);
  
  const d = project.data;
  const resultClass = d?.result?.realRevenue
    ? 'REAL'
    : d?.result && /PAPER|SIMULAT|TEST/i.test(d.result.resultType) ? 'SIMULATED' : 'POTENTIAL';
  
  return (
    <div>
      <Link href="/proyectos" className="back-link"><ArrowLeft size={14} /> Volver a proyectos</Link>
      <DataState loading={project.isLoading} error={!!project.error} empty={!project.isLoading && !d} onRetry={() => void project.refetch()}>
        {d && (
          <>
            <PageHeader 
              eyebrow={`Proyecto / PRJ-${String(d.project.id).padStart(4, '0')}`} 
              title={d.project.name} 
              description={`Conectado a la oportunidad OP-${d.project.opportunityId}. Fase actual: ${d.actualStage}`}
              action={
                <div className="flex gap-2">
                  <Badge value={d.project.status} />
                  <Badge value={`QA: ${d.project.qaStatus || 'PENDING'}`} />
                </div>
              }
            />

            <div className="mb-8">
              <div className="flex justify-between items-end mb-2">
                <div><div className="eyebrow">Progreso persistido</div><strong>{d.progress}% · {d.tasks.filter((task) => task.completed).length} completadas · {d.tasks.filter((task) => !task.completed).length} pendientes</strong></div>
                <Badge value={d.actualStage} small />
              </div>
              <div className="h-2 w-full bg-secondary rounded overflow-hidden">
                <div className="h-full bg-accent transition-all" style={{ width: `${d.progress}%` }} />
              </div>
            </div>

            <div className="dashboard-grid">
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <div className="eyebrow">Etapas</div>
                    <h3>Gates de Ejecución</h3>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  {d.gates.map((gate) => (
                    <div key={gate.key} className={cx('flex items-center justify-between p-3 border rounded', gate.completed ? 'bg-secondary border-border' : 'border-border/50')}>
                      <div className="flex items-center gap-3">
                        {gate.completed ? <CheckCircle2 size={16} className="text-[hsl(145_43%_41%)]" /> : <CircleAlert size={16} className="text-muted-foreground" />}
                        <div>
                          <strong className="text-sm">{gate.key}</strong>
                          <span className="block text-xs text-muted-foreground">Estado: {gate.status}</span>
                        </div>
                      </div>
                      {gate.completedAt && <span className="text-xs text-muted-foreground">{formatDate(gate.completedAt)}</span>}
                    </div>
                  ))}
                </div>
              </section>

              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <div className="eyebrow">Validación</div>
                    <h3>Control de Calidad (QA)</h3>
                  </div>
                </div>
                {d.project.qaScore !== null && d.project.qaScore !== undefined ? (
                  <div className="flex items-center gap-4 mb-4">
                    <div className="text-4xl font-serif text-accent">{d.project.qaScore}/100</div>
                    <div className="text-sm text-muted-foreground">Puntuación automatizada de calidad.</div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground mb-4">Control de calidad pendiente.</p>
                )}

                {d.project.qaIssues && d.project.qaIssues.length > 0 && (
                  <div className="mb-4">
                    <strong className="text-xs mb-2 block text-destructive">Problemas Detectados</strong>
                    <ul className="list-disc list-inside text-xs space-y-1 text-muted-foreground pl-4">
                      {d.project.qaIssues.map((i, idx) => <li key={idx}>{i}</li>)}
                    </ul>
                  </div>
                )}

                {d.project.qaRecommendations && d.project.qaRecommendations.length > 0 && (
                  <div>
                    <strong className="text-xs mb-2 block text-accent">Recomendaciones</strong>
                    <ul className="list-disc list-inside text-xs space-y-1 text-muted-foreground pl-4">
                      {d.project.qaRecommendations.map((i, idx) => <li key={idx}>{i}</li>)}
                    </ul>
                  </div>
                )}
              </section>
            </div>

            <div className="mt-8 detail-grid">
              <div className="detail-primary">
                <section className="panel mb-6">
                  <div className="panel-heading">
                    <div><div className="eyebrow">Plan operativo</div><h3>Tareas y acciones registradas</h3></div>
                  </div>
                  <div className="grid gap-2 mb-6">
                    {d.tasks.map((task) => (
                      <div key={task.key} className="flex items-center justify-between p-3 border border-border rounded">
                        <div><strong className="text-sm">{task.title}</strong><span className="block text-xs text-muted-foreground">{task.sourceId ? `Fuente ${task.sourceId}` : 'Sin ejecución persistida'}</span></div>
                        <Badge value={task.completed ? 'COMPLETED' : task.status} small />
                      </div>
                    ))}
                  </div>
                  <div className="panel-heading">
                    <div><div className="eyebrow">Actividad</div><h3>Línea temporal del proyecto</h3></div>
                    <ActivityIcon size={16} />
                  </div>
                  {d.activities.length ? <div className="activity-list activity-compact">{d.activities.map((activity) => (
                    <div className="activity-row" key={activity.id}>
                      <div className="activity-marker"><span /></div>
                      <div className="activity-body"><div className="activity-meta"><strong>{activity.stage}</strong><span>{formatDate(activity.createdAt)}</span></div><p>{activity.message}</p><Badge value={activity.status} small /></div>
                    </div>
                  ))}</div> : <p className="text-sm text-muted-foreground">No hay actividad persistida para este proyecto.</p>}
                </section>
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <div className="eyebrow">Entregables</div>
                      <h3>Artefactos del Proyecto</h3>
                    </div>
                  </div>
                  {d.artifacts.length > 0 ? (
                    <div className="flex flex-col gap-4">
                      {d.artifacts.map((a, i) => (
                        <div key={i} className="p-4 border border-border rounded bg-card">
                          <div className="flex items-center gap-2 mb-3">
                            <FileSearch size={16} className="text-accent" />
                            <strong className="text-sm">{a.kind}</strong>
                            <Badge value={a.sourceId} small />
                          </div>
                          <pre className="text-xs font-mono bg-secondary p-3 rounded overflow-x-auto whitespace-pre-wrap">
                            {JSON.stringify(a.data, null, 2)}
                          </pre>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">Sin artefactos generados aún.</p>
                  )}
                </section>
              </div>

              <div className="detail-aside">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <div className="eyebrow">Resultado</div>
                      <h3>Impacto Final</h3>
                    </div>
                  </div>
                  {d.result ? (
                    <div>
                      <div className="fact"><span>Tipo</span><strong>{d.result.resultType}</strong></div>
                      <div className="fact"><span>Resultado</span><strong>{d.result.outcome}</strong></div>
                       <div className="fact"><span>Clasificación</span><Badge value={resultClass} small /></div>
                       <div className="fact"><span>Importe registrado</span><strong>${d.result.revenue.toFixed(2)}</strong></div>
                       <div className="fact"><span>REAL_VERIFIED</span><strong style={{ color: d.result.realRevenue ? 'hsl(145 43% 41%)' : 'hsl(var(--destructive))' }}>{d.result.realRevenue ? 'TRUE' : 'FALSE'}</strong></div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">Esperando resultados del proyecto.</p>
                  )}
                </section>

                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <div className="eyebrow">Memoria</div>
                      <h3>Aprendizaje Capturado</h3>
                    </div>
                  </div>
                  {d.learning ? (
                    <div>
                      <h4 className="text-sm font-semibold mb-2">{d.learning.title}</h4>
                      <p className="text-xs text-muted-foreground mb-4">{d.learning.summary}</p>
                      <Badge value={d.learning.status} small />
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">El ciclo aún no ha documentado aprendizajes.</p>
                  )}
                </section>
              </div>
            </div>
          </>
        )}
      </DataState>
    </div>
  );
}
