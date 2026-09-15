import { Activity, AlertTriangle, Bell, Check, Database, RefreshCw, ShieldCheck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useAcknowledgeIncident,
  useGetOperationalMetrics,
  useGetOwnerConfiguration,
  useListDeadLetterEvents,
  useListIncidents,
  useListNotifications,
  useListStorageObjects,
  useMarkNotificationRead,
  useReadinessCheck,
  useRetryDeadLetterEvent,
} from '@workspace/api-client-react';
import { Badge, DataState, PageHeader, formatDate } from '@/App';

function asRows(value: unknown): any[] { return Array.isArray(value) ? value : []; }

export default function OperacionesPage() {
  const qc = useQueryClient();
  const readiness = useReadinessCheck();
  const metrics = useGetOperationalMetrics();
  const config = useGetOwnerConfiguration();
  const notifications = useListNotifications();
  const incidents = useListIncidents();
  const dlq = useListDeadLetterEvents();
  const storage = useListStorageObjects();
  const markRead = useMarkNotificationRead();
  const acknowledge = useAcknowledgeIncident();
  const retry = useRetryDeadLetterEvent();

  const refresh = () => qc.invalidateQueries();
  const notificationRows = asRows(notifications.data);
  const incidentRows = asRows(incidents.data);
  const dlqRows = asRows(dlq.data);
  const storageRows = asRows(storage.data);
  const ready: any = readiness.data;
  const owner: any = config.data;
  const metricData: any = metrics.data;

  return <div>
    <PageHeader eyebrow="Operación / P1" title="Centro operativo" description="Salud, alertas, notificaciones, almacenamiento y fallos recuperables en una sola vista." action={<button className="button button-secondary" onClick={refresh}><RefreshCw size={14}/> Actualizar</button>} />

    <div className="grid gap-4 md:grid-cols-4 mb-6">
      <section className="panel p-4"><div className="eyebrow">Readiness</div><div className="mt-2 flex items-center gap-2"><Activity size={17}/><Badge value={ready?.status || (readiness.isLoading ? 'RUNNING' : 'UNKNOWN')} /></div><p className="mt-2 text-sm text-muted-foreground">DB, storage y workers.</p></section>
      <section className="panel p-4"><div className="eyebrow">Autonomía</div><div className="mt-2"><Badge value={owner?.autonomyEnabled ? 'ON' : 'OFF'} /></div><p className="mt-2 text-sm text-muted-foreground">Execution lock: {owner?.autonomyExecutionLocked === false ? 'OFF' : 'ON'}</p></section>
      <section className="panel p-4"><div className="eyebrow">Finanzas</div><div className="mt-2"><Badge value={owner?.financeMode || 'REAL_ZERO'} /></div><p className="mt-2 text-sm text-muted-foreground">Pagos: {owner?.paymentsAllowed ? 'habilitados' : 'bloqueados'}</p></section>
      <section className="panel p-4"><div className="eyebrow">Telemetría</div><strong className="mt-2 block text-2xl">{metricData?.requestsTotal ?? metricData?.totalRequests ?? '—'}</strong><p className="text-sm text-muted-foreground">Solicitudes observadas</p></section>
    </div>

    <div className="grid gap-5 lg:grid-cols-2">
      <section className="panel p-5"><div className="panel-heading"><div><div className="eyebrow">Bandeja interna</div><h3>Notificaciones</h3></div><Bell size={18}/></div><DataState loading={notifications.isLoading} error={!!notifications.error} empty={!notifications.isLoading && !notificationRows.length} onRetry={() => void notifications.refetch()}><div className="space-y-3">{notificationRows.map((n) => <div key={n.id} className="approval-detail"><div><strong>{n.title || n.type || 'Notificación'}</strong><p>{n.message || n.summary || 'Evento operativo'}</p><span>{formatDate(n.createdAt)}</span></div>{!n.readAt && <button className="button button-secondary button-small" disabled={markRead.isPending} onClick={() => markRead.mutate({ id: n.id }, { onSuccess: refresh })}><Check size={13}/> Leída</button>}</div>)}</div></DataState></section>

      <section className="panel p-5"><div className="panel-heading"><div><div className="eyebrow">Observabilidad</div><h3>Incidentes</h3></div><AlertTriangle size={18}/></div><DataState loading={incidents.isLoading} error={!!incidents.error} empty={!incidents.isLoading && !incidentRows.length} onRetry={() => void incidents.refetch()}><div className="space-y-3">{incidentRows.map((i) => <div key={i.id} className="approval-detail"><div><strong>{i.title || i.code || 'Incidente'}</strong><p>{i.message || i.summary || i.status}</p><Badge value={i.status} small /></div>{i.status !== 'ACKNOWLEDGED' && <button className="button button-secondary button-small" disabled={acknowledge.isPending} onClick={() => acknowledge.mutate({ id: i.id }, { onSuccess: refresh })}><ShieldCheck size={13}/> Reconocer</button>}</div>)}</div></DataState></section>

      <section className="panel p-5"><div className="panel-heading"><div><div className="eyebrow">Recuperación</div><h3>Dead Letter Queue</h3></div><RefreshCw size={18}/></div><DataState loading={dlq.isLoading} error={!!dlq.error} empty={!dlq.isLoading && !dlqRows.length} onRetry={() => void dlq.refetch()}><div className="space-y-3">{dlqRows.map((e) => <div key={e.id} className="approval-detail"><div><strong>{e.eventType || `Evento #${e.id}`}</strong><p>{e.lastError || 'Fallo pendiente de revisión humana'}</p><Badge value={e.status} small /></div><button className="button button-secondary button-small" disabled={retry.isPending} onClick={() => retry.mutate({ id: e.id, data: { humanCheckpoint: true, idempotencyKey: `ui-${e.id}-${Date.now()}` } }, { onSuccess: refresh })}>Reintentar</button></div>)}</div></DataState></section>

      <section className="panel p-5"><div className="panel-heading"><div><div className="eyebrow">App Storage</div><h3>Objetos persistidos</h3></div><Database size={18}/></div><DataState loading={storage.isLoading} error={!!storage.error} empty={!storage.isLoading && !storageRows.length} onRetry={() => void storage.refetch()}><div className="space-y-3">{storageRows.map((o) => <div key={o.id} className="approval-detail"><div><strong>{o.fileName || `Objeto #${o.id}`}</strong><p>{o.contentType || 'application/octet-stream'} · {o.byteSize ?? 0} bytes</p><span>SHA-256: {String(o.sha256 || '').slice(0, 16)}…</span></div></div>)}</div></DataState></section>
    </div>
  </div>;
}
