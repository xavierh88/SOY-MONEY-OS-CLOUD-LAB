import { useEffect, useMemo, useState } from 'react';
import { Check, Database, RefreshCw, Search, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { useGetOwnerConfiguration, useUpdateOwnerConfiguration } from '@workspace/api-client-react';
import { Badge, DataState, PageHeader, formatDate } from '@/App';

type IntegrationState = 'NOT_CONFIGURED' | 'AVAILABLE' | 'DEGRADED' | 'DISABLED';

const labels: Record<string, string> = {
  BRAVE_SEARCH: 'Brave Search',
  HN_ALGOLIA: 'Hacker News / Algolia',
  STACK_EXCHANGE: 'Stack Exchange',
  GITHUB_ISSUES: 'GitHub Issues',
  APP_STORAGE: 'App Storage',
  DATABASE: 'PostgreSQL',
};

export default function ConfiguracionPage() {
  const config = useGetOwnerConfiguration();
  const update = useUpdateOwnerConfiguration();
  const [draft, setDraft] = useState<Record<string, IntegrationState>>({});
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (config.data) setDraft(config.data.integrationStatuses as Record<string, IntegrationState>);
  }, [config.data]);

  const integrations = useMemo(() => Object.entries(draft).sort(([a], [b]) => a.localeCompare(b)), [draft]);
  const dirty = config.data ? JSON.stringify(draft) !== JSON.stringify(config.data.integrationStatuses) : false;

  const save = () => {
    if (!dirty || update.isPending) return;
    setMessage(null);
    update.mutate({ data: { integrationStatuses: draft } }, {
      onSuccess: () => {
        setMessage('Configuración persistida correctamente.');
        void config.refetch();
      },
      onError: () => setMessage('No se pudo guardar. Ningún cambio se marcó como aplicado.'),
    });
  };

  return <div>
    <PageHeader eyebrow="Sistema / Configuración" title="Configuración persistente" description="Estado real de políticas e integraciones. Esta pantalla nunca muestra ni solicita secretos." action={<button className="button button-primary" onClick={save} disabled={!dirty || update.isPending} data-testid="button-save-owner-config"><Check size={15} />{update.isPending ? 'Guardando…' : 'Guardar cambios'}</button>} />
    <DataState loading={config.isLoading} error={!!config.error} empty={!config.isLoading && !config.data} onRetry={() => void config.refetch()}>
      {config.data && <>
        {message && <div className="panel mb-6" role="status">{message}</div>}
        <div className="dashboard-grid mb-6">
          <section className="panel">
            <div className="panel-heading"><div><div className="eyebrow">Guardrails</div><h3>Política operativa efectiva</h3></div><ShieldCheck size={17} /></div>
            <div className="fact"><span>Autonomía</span><Badge value={config.data.autonomyEnabled ? 'ON' : 'OFF'} small /></div>
            <div className="fact"><span>Execution lock</span><Badge value={config.data.autonomyExecutionLocked ? 'LOCKED' : 'UNLOCKED'} small /></div>
            <div className="fact"><span>Modo financiero</span><Badge value={config.data.financeMode} small /></div>
            <div className="fact"><span>Pagos reales</span><Badge value={config.data.paymentsAllowed ? 'ON' : 'OFF'} small /></div>
            <div className="fact"><span>Publicación externa</span><Badge value={config.data.publishingAllowed ? 'ON' : 'OFF'} small /></div>
            <div className="fact"><span>APIs externas operativas</span><Badge value={config.data.externalApisAllowed ? 'ON' : 'OFF'} small /></div>
            <div className="fact"><span>Windmill</span><Badge value={config.data.windmillLegacyUnused ? 'LEGACY_UNUSED' : 'ACTIVE'} small /></div>
          </section>
          <section className="panel">
            <div className="panel-heading"><div><div className="eyebrow">Autoridad</div><h3>Owner configuration</h3></div><SlidersHorizontal size={17} /></div>
            <p className="section-intro">El backend es la autoridad. Los bloqueos de seguridad no se pueden desactivar desde esta interfaz.</p>
            <div className="fact"><span>ID de configuración</span><strong>{config.data.id}</strong></div>
            <div className="fact"><span>Última actualización</span><strong>{formatDate(String(config.data.updatedAt))}</strong></div>
            <button className="button button-secondary mt-4" onClick={() => void config.refetch()} disabled={config.isFetching} data-testid="button-refresh-owner-config"><RefreshCw size={14} />Actualizar desde backend</button>
          </section>
        </div>
        <section className="panel integrations">
          <div className="panel-heading"><div><div className="eyebrow">Dependencias</div><h3>Integraciones persistidas</h3></div><Badge value={integrations.some(([, state]) => state === 'DEGRADED') ? 'DEGRADED' : 'CONFIGURED'} small /></div>
          <p className="section-intro">Aquí solo se administra el estado operativo permitido. Tokens, API keys, credenciales y secretos permanecen fuera del frontend.</p>
          {integrations.length === 0 ? <div className="empty-state"><Database size={20} /><strong>Sin integraciones registradas</strong><span>El backend todavía no ha persistido estados de integración.</span></div> : integrations.map(([key, state], index) => <div className="integration-row" key={key} data-testid={`row-owner-integration-${key}`}>
            <div className="integration-symbol">{key.includes('SEARCH') ? <Search size={16} /> : <Database size={16} />}</div>
            <div><strong>{labels[key] || key.replaceAll('_', ' ')}</strong><span>Estado persistido por Owner Configuration</span></div>
            <Badge value={state} small />
            <select aria-label={`Estado ${key}`} value={state} onChange={(event) => { setMessage(null); setDraft((current) => ({ ...current, [key]: event.target.value as IntegrationState })); }} data-testid={`select-owner-integration-${index}`}>
              <option value="NOT_CONFIGURED">NOT_CONFIGURED</option><option value="AVAILABLE">AVAILABLE</option><option value="DEGRADED">DEGRADED</option><option value="DISABLED">DISABLED</option>
            </select>
          </div>)}
        </section>
        <div className="panel mt-6"><div className="eyebrow">Límite de seguridad</div><p className="section-intro mb-0">Cambiar un estado de integración no autoriza gasto, publicación, pagos, operaciones financieras ni ejecución autónoma. Esas capacidades permanecen bloqueadas por política del backend.</p></div>
      </>}
    </DataState>
  </div>;
}
