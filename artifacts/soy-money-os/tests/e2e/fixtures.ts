import type { Page, Route } from '@playwright/test';

const NOW = '2025-01-15T12:00:00.000Z';

export const opportunity = {
  id: 1,
  name: 'Cobro simple para clínicas',
  description: 'Una señal validada para reducir fricción de cobro en clínicas pequeñas.',
  sector: 'Healthtech',
  problem: 'Las clínicas pierden tiempo conciliando pagos.',
  targetCustomer: 'Clínicas independientes',
  proposedSolution: 'Un flujo de cobro y conciliación simple.',
  monetizationMethod: 'Suscripción mensual',
  score: 84,
  estimatedCost: 1200,
  difficulty: 'LOW',
  risk: 'LOW',
  timeToRevenue: '2-4 semanas',
  status: 'PENDING_REVIEW',
  proofStatus: 'REAL_UNVERIFIED',
  source: 'fixture discovery',
  sourceUrl: null,
  category: 'BUSINESS',
  titleClaim: null,
  evidenceRefs: ['fixture-evidence-1'],
  fingerprint: 'fixture-opportunity-1',
  researchStatus: 'COMPLETED',
  demandConfidence: 0.82,
  detectedAt: NOW,
  validFrom: NOW,
  validUntil: null,
  expiresAt: null,
  expirationReason: null,
  expiredAt: null,
  expirationOutcome: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const evidence = [{
  id: 1,
  opportunityId: 1,
  source: 'fixture discovery',
  url: '/fixture/evidence',
  collectedAt: NOW,
  claim: 'Las clínicas reportan conciliación manual de pagos.',
  verificationStatus: 'NOT_VERIFIED',
  contradictions: [],
  gaps: ['Requiere entrevista de propietario'],
  proofType: 'SEARCH_EVIDENCE',
}];

const approval = {
  id: 10,
  opportunityId: 1,
  type: 'OPPORTUNITY_REVIEW',
  status: 'PENDING',
  reason: 'Revisión humana obligatoria antes de construir.',
  createdAt: NOW,
};

const project = {
  id: 1,
  opportunityId: 1,
  name: 'Cobro simple para clínicas · MVP',
  status: 'BUILD',
  qaStatus: 'PASSED',
  qaScore: 92,
  qaIssues: [],
  qaRecommendations: ['Medir activación en la primera semana.'],
  qaCheckedAt: NOW,
  sellPackage: { deliverable: 'LANDING_PAGE' },
  publicationExecuted: false,
  marketingExecuted: false,
  saleExecuted: false,
  financialExecution: false,
  createdAt: NOW,
  updatedAt: NOW,
};

const result = {
  id: 1,
  projectId: 1,
  resultType: 'PAPER_SIMULATION',
  outcome: 'Interés inicial positivo; no es una venta real.',
  status: 'COMPLETED',
  revenue: 0,
  cost: 0,
  profit: 0,
  mode: 'PAPER',
  financeIdempotencyKey: null,
  realRevenue: false,
  createdAt: NOW,
};

const activity = [{
  id: 1,
  executionId: 1,
  stage: 'DISCOVERY',
  status: 'COMPLETED',
  message: 'Señal registrada en fixture.',
  createdAt: NOW,
}];

const projectDetail = {
  project,
  actualStage: 'QA',
  progress: 72,
  gates: [
    { key: 'DISCOVERY', status: 'COMPLETED', completed: true, completedAt: NOW, sourceId: '1' },
    { key: 'QA', status: 'PASSED', completed: true, completedAt: NOW, sourceId: 'qa-1' },
    { key: 'SELL_READY', status: 'BLOCKED', completed: false, completedAt: null, sourceId: null },
  ],
  tasks: [
    { key: 'T1', title: 'Validar propuesta', status: 'COMPLETED', completed: true, sourceId: 'task-1' },
    { key: 'T2', title: 'Preparar paquete', status: 'PENDING', completed: false, sourceId: null },
  ],
  artifacts: [],
  execution: null,
  activities: activity,
  result,
  learning: { id: 1, projectId: 1, title: 'La confianza acelera la prueba', summary: 'La evidencia explícita mejora la siguiente iteración.', status: 'ACTIVE', createdAt: NOW },
};

const opportunityDetail = {
  opportunity,
  presentationStatus: 'REVIEW',
  executable: false,
  evidence,
  metadata: {
    id: 1,
    opportunityId: 1,
    normalizedName: opportunity.name,
    normalizedProblem: opportunity.problem,
    normalizedTarget: opportunity.targetCustomer,
    normalizedSolution: opportunity.proposedSolution,
    contentHash: 'fixture',
    similarityFingerprint: 'fixture',
    scoreBreakdown: { demand: 84, feasibility: 80 },
    demandProofStatus: opportunity.proofStatus,
    createdAt: NOW,
    updatedAt: NOW,
  },
  approvals: [approval],
  projects: [project],
  results: [result],
  learning: [projectDetail.learning],
  activity,
};

export type FixtureState = {
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED';
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/**
 * All application API requests are handled here. No request can reach the
 * API server or an external service during browser E2E.
 */
export async function installFixtureApi(page: Page): Promise<FixtureState> {
  const state: FixtureState = { approvalStatus: 'PENDING' };
  // Fonts, Clerk, analytics, and accidental links must never leave the
  // fixture origin. Fallback lets the API route below handle /api requests.
  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (/^https?:$/.test(requestUrl.protocol) && !['127.0.0.1', 'localhost'].includes(requestUrl.hostname)) {
      await route.abort();
      return;
    }
    await route.fallback();
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (request.method() === 'POST' && /^\/api\/approvals\/\d+\/decision$/.test(path)) {
      const body = request.postDataJSON() as { decision?: 'approved' | 'rejected' };
      state.approvalStatus = body.decision === 'approved' ? 'APPROVED' : 'REJECTED';
      await json(route, { ...approval, status: state.approvalStatus, decidedAt: NOW });
      return;
    }

    if (path === '/api/health') return json(route, { status: 'ok' });
    if (path === '/api/dashboard') return json(route, {
      opportunitiesFound: 1,
      opportunitiesVerified: 0,
      projects: 1,
      activeProcesses: 1,
      failedProcesses: 0,
      pendingApprovals: state.approvalStatus === 'PENDING' ? 1 : 0,
      results: 1,
      systemStatus: 'HEALTHY',
      recentActivity: activity,
    });
    if (path === '/api/opportunities') return json(route, [opportunity]);
    if (path === '/api/opportunities/1' || path === '/api/control-tower/opportunities/1') return json(route, opportunityDetail);
    if (path === '/api/approvals') return json(route, state.approvalStatus === 'PENDING' ? [{ ...approval, status: state.approvalStatus }] : []);
    if (path === '/api/projects') return json(route, [project]);
    if (path === '/api/projects/1' || path === '/api/control-tower/projects/1') return json(route, projectDetail);
    if (path === '/api/results') return json(route, [result]);
    if (path === '/api/demand-proof') return json(route, [{ id: 1, opportunityId: 1, proofType: 'SEARCH_EVIDENCE', status: 'REAL_UNVERIFIED', summary: evidence[0].claim, createdAt: NOW }]);
    if (path === '/api/activity') return json(route, activity);
    if (path === '/api/control-tower/timeline') return json(route, [{
      sourceType: 'OPPORTUNITY',
      sourceId: '1',
      eventType: 'DISCOVERY',
      status: 'COMPLETED',
      timestamp: NOW,
      opportunityId: 1,
      projectId: 1,
      marketCycleId: null,
      title: 'Señal descubierta',
      description: 'Fixture de trazabilidad.',
      actor: 'fixture',
      currentAction: null,
      nextAction: 'Revisión humana',
    }]);
    if (path === '/api/autonomy/status') return json(route, { status: 'OFF' });
    if (path === '/api/autonomy/candidates' || path === '/api/human-actions') return json(route, []);
    if (path === '/api/finance/summary') return json(route, { real: 0, paper: 0, potential: 0 });
    if (path === '/api/cycles/current') return json(route, null);

    // Keep unneeded endpoints deterministic too; a missing fixture is visible
    // as an empty state instead of accidentally calling a real service.
    await json(route, request.method() === 'GET' ? [] : { ok: true });
  });
  return state;
}