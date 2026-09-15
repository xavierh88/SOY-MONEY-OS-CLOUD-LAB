import { Link } from 'wouter';
import { Layers3, ArrowRight } from 'lucide-react';
import { useListProjects } from '@workspace/api-client-react';
import { PageHeader, DataState, Badge, formatDate } from '@/App';

export default function ProyectosPage() {
  const projects = useListProjects();
  const p = projects.data || [];

  return (
    <div>
      <PageHeader 
        eyebrow="Trazabilidad / 02" 
        title="Proyectos" 
        description="Construcciones, experimentos y activos en desarrollo en base a oportunidades verificadas." 
        action={<div className="header-stamp"><Layers3 size={15} /> Portafolio Activo</div>}
      />
      
      <DataState loading={projects.isLoading} error={!!projects.error} empty={!projects.isLoading && p.length === 0} onRetry={() => void projects.refetch()}>
        <div className="opportunity-list">
          {p.map((project) => (
            <Link href={`/proyectos/${project.id}`} key={project.id} className="opportunity-card" data-testid={`card-project-${project.id}`}>
              <div className="project-top">
                <span className="record-id">PRJ-{String(project.id).padStart(4, '0')}</span>
                <Badge value={project.status} small />
                <span className="card-date">{formatDate(project.createdAt)}</span>
              </div>
              <div className="opportunity-main">
                <div className="opportunity-copy">
                  <h3>{project.name}</h3>
                  <div className="opportunity-tags">
                    <span>OP-{project.opportunityId}</span>
                    {project.qaStatus && <span>QA: {project.qaStatus}</span>}
                    {project.qaScore && <span>QA SCORE: {project.qaScore}/100</span>}
                  </div>
                </div>
                <ArrowRight className="card-arrow" size={18} />
              </div>
              <div className="opportunity-bottom">
                <span><b>Publicación</b>{project.publicationExecuted ? 'EJECUTADA' : 'PENDIENTE'}</span>
                <span><b>Venta</b>{project.saleExecuted ? 'EJECUTADA' : 'PENDIENTE'}</span>
                <span><b>Finanzas</b>{project.financialExecution ? 'ACTIVA' : 'OFF'}</span>
              </div>
            </Link>
          ))}
        </div>
      </DataState>
    </div>
  );
}
