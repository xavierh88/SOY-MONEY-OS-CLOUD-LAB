# SOY MONEY OS

Consola en español para descubrir, investigar, verificar y priorizar oportunidades con evidencia trazable y aprobación humana.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/soy-money-os/src/` — frontend responsive y navegación de la consola.
- `artifacts/api-server/src/routes/soy-money.ts` — endpoints del flujo end-to-end.
- `lib/api-spec/openapi.yaml` — contrato único de API.
- `lib/db/src/schema/soy-money.ts` — tablas persistentes del dominio.
- `artifacts/soy-money-os/src/index.css` — tokens y tema visual.

## Architecture decisions

- El primer ciclo ejecuta DISCOVER → RESEARCH → EVIDENCE → VERIFY → SCORE → DEMAND_PROOF y se detiene antes de construir automáticamente.
- La evidencia de la V1 se etiqueta `TEST_SIMULATION` y no desbloquea gates; `REAL_VERIFIED` queda reservado para integraciones futuras.
- Las acciones sensibles pasan por `approvals`; una aprobación explícita crea un proyecto exploratorio, pero no ejecuta dinero real ni operaciones financieras.
- El modelo conserva executions, activity, evidence, demand proof, results y learning para que un orquestador futuro pueda continuar desde checkpoints.

## Product

Dashboard ejecutivo, Opportunity Engine, Research/Evidence Ledger, Verifier, Scoring, Demand Proof, Projects, Results, Learning, approval checkpoints y activity log.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Las fuentes externas no están configuradas; el pipeline local lo muestra como `NOT_CONFIGURED` y no lo presenta como demanda real.
- Después de cambiar `lib/api-spec/openapi.yaml`, ejecutar codegen antes de usar nuevos hooks o schemas.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
