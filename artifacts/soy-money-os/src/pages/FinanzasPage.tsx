import { 
  useGetFinanceSummary, 
  useListFinanceLedger, 
  useListFinancePlatforms, 
  useGetWithdrawableFinance 
} from '@workspace/api-client-react';
import { Database, Landmark, CreditCard, ArrowRight, ShieldCheck } from 'lucide-react';
import { PageHeader, DataState, MetricCard, Badge, statusTone, formatDate, formatTime } from '@/App';

export default function FinanzasPage() {
  const summaryQuery = useGetFinanceSummary();
  const ledgerQuery = useListFinanceLedger();
  const platformsQuery = useListFinancePlatforms();
  const withdrawableQuery = useGetWithdrawableFinance();

  const summary = summaryQuery.data;
  const ledger = ledgerQuery.data || [];
  const platforms = platformsQuery.data || [];
  const withdrawable = withdrawableQuery.data;

  return (
    <div>
      <PageHeader 
        eyebrow="Trazabilidad / 06" 
        title="Realidad Financiera" 
        description="Muro de separación estricta entre dinero simulado (PAPER), valor no capturado (POTENTIAL) y dinero líquido verificado en plataformas reales (REAL)."
      />

      <div className="metric-grid">
        <MetricCard 
          label="Dinero Real (Líquido)" 
          value={`$${summary?.real?.toFixed(2) || '0.00'}`} 
          note="Eventos marcados como REAL" 
          icon={Landmark} 
          tone="lime" 
        />
        <MetricCard 
          label="Simulación (Paper)" 
          value={`$${summary?.paper?.toFixed(2) || '0.00'}`} 
          note="Modelos asintóticos" 
          icon={Database} 
          tone="blue" 
        />
        <MetricCard 
          label="Valor Potencial" 
          value={`$${summary?.potential?.toFixed(2) || '0.00'}`} 
          note="Ingresos proyectados" 
          icon={CreditCard} 
          tone="amber" 
        />
        <MetricCard 
          label="Disponible para Retiro" 
          value={`$${withdrawable?.amount?.toFixed(2) || '0.00'}`} 
          note={withdrawable?.currency || 'USD'} 
          icon={ShieldCheck} 
          tone="coral" 
        />
      </div>

      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Cuentas y Pasarelas</div>
              <h3>Plataformas conectadas</h3>
            </div>
          </div>
          <DataState loading={platformsQuery.isLoading} error={!!platformsQuery.error} empty={!platformsQuery.isLoading && platforms.length === 0} onRetry={() => void platformsQuery.refetch()}>
            <div className="opportunity-list">
              {platforms.map(platform => (
                <div key={platform.id} className="opportunity-card">
                  <div className="opportunity-top">
                    <span className="record-id">{platform.platform}</span>
                    <Badge value={platform.mode} small />
                  </div>
                  <div className="py-4">
                    <h3 className="text-lg font-semibold mb-1">{platform.accountName}</h3>
                    <div className="flex gap-4 mt-2 font-mono text-sm">
                      <div>
                        <span className="block text-[9px] text-muted-foreground uppercase mb-1">Disponible</span>
                        ${platform.availableAmount.toFixed(2)}
                      </div>
                      <div>
                        <span className="block text-[9px] text-muted-foreground uppercase mb-1">Retirable</span>
                        <span style={{ color: platform.mode === 'REAL' ? 'hsl(145 43% 41%)' : 'inherit' }}>
                          ${platform.withdrawableAmount.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </DataState>
          
          <div className="mt-8 p-4 border" style={{ borderColor: 'hsl(var(--destructive)/0.3)', backgroundColor: 'hsl(var(--destructive)/0.05)' }}>
            <h4 className="text-sm font-semibold flex items-center gap-2 mb-2" style={{ color: 'hsl(var(--destructive))' }}>
              <ShieldCheck size={16} /> Retiros requieren autorización
            </h4>
            <p className="text-xs text-muted-foreground">
              El motor autónomo no puede mover dinero real hacia cuentas externas. Cualquier retiro requerirá autorización humana explícita antes de habilitar una integración.
            </p>
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Libro Mayor</div>
              <h3>Registro de Transacciones</h3>
            </div>
          </div>
          <DataState loading={ledgerQuery.isLoading} error={!!ledgerQuery.error} empty={!ledgerQuery.isLoading && ledger.length === 0} onRetry={() => void ledgerQuery.refetch()}>
            <div className="activity-list activity-compact">
              {ledger.map((entry) => (
                <div className="activity-row items-center" key={entry.id}>
                  <div className={`activity-marker ${statusTone(entry.mode)}`}><span /></div>
                  <div className="activity-body">
                    <div className="activity-meta">
                      <strong>{entry.entryType}</strong>
                      <span>{formatDate(entry.createdAt)}</span>
                    </div>
                    <div className="flex justify-between items-center mt-1">
                      <p className="m-0 text-xs">{entry.description}</p>
                      <strong className="font-mono text-sm" style={{ color: entry.mode === 'REAL' ? 'hsl(145 43% 41%)' : 'inherit' }}>
                        {entry.amount > 0 ? '+' : ''}{entry.amount.toFixed(2)} {entry.currency}
                      </strong>
                    </div>
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
