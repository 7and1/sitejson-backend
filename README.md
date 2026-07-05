# SiteJSON Backend

Production-oriented modular backend scaffold for SiteJSON.

## Scripts

- `npm run dev` — start local dev server
- `npm run worker` — start standalone async worker
- `npm run build` — compile TypeScript
- `npm run test` — run tests
- `npm run typecheck` — compile in noEmit mode
- `npm run backfill:directory-fields` — dry-run derived `site_profiles` directory/search fields
- `npm run backfill:directory-fields -- --apply` — apply the derived field backfill in batches
- `npm run backfill:alternatives-cache` — dry-run durable alternatives cache candidates
- `npm run backfill:alternatives-cache -- --apply` — generate short-lived `site_alternatives_cache` rows
- `npm run retention:cleanup` — dry-run terminal job and expired alternatives-cache cleanup
- `npm run security:scan` — redacted hardcoded secret scan across backend/docs/ops surfaces

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/sites/analyze` | Yes | Trigger domain analysis |
| `GET` | `/api/v1/sites/:domain` | Yes | Get site report (`?debug=true` returns internal metadata only with ops key) |
| `GET` | `/api/v1/sites/:domain/providers` | Yes | Provider-level completeness breakdown |
| `GET` | `/api/v1/sites/:domain/providers/:provider` | Yes | Single provider detail |
| `GET` | `/api/v1/sites/:domain/alternatives` | Yes | Similar sites |
| `POST` | `/api/v1/ingest/domains` | Yes | Bulk domain ingest |
| `GET` | `/api/v1/jobs/:jobId` | Yes | Poll job status (includes `Retry-After` header) |
| `GET` | `/api/v1/directory/:type/:slug` | Yes | Directory listings |
| `GET` | `/api/v1/ops/dashboard` | Ops | Ops dashboard stats |
| `GET` | `/api/v1/ops/queues` | Ops | Queue counts |
| `POST` | `/api/v1/ops/retry-dlq` | Ops | Retry failed jobs |
| `GET` | `/api/v1/healthz` | No | Liveness probe |
| `GET` | `/api/v1/readyz` | No | Readiness probe (DB + Redis + Queue) |
| `GET` | `/api/docs` | No | Swagger UI (disabled in production) |
| `GET` | `/api/openapi.json` | No | OpenAPI spec (disabled in production) |

Auth: `x-api-key` header or `Authorization: Bearer <key>` (production only).
`SITEJSON_API_KEY` is for normal API reads and standard analyze/ingest requests.
`SITEJSON_OPS_API_KEY` is required for `/api/v1/ops/*`, `force_refresh`, `force_ai`, `priority=high`, and debug metadata.
Analyze and ingest rate limits are tiered by key role. Use
`ANALYZE_RATE_LIMIT_PUBLIC_PER_MIN` / `ANALYZE_RATE_LIMIT_OPS_PER_MIN` and
`INGEST_RATE_LIMIT_PUBLIC_PER_MIN` / `INGEST_RATE_LIMIT_OPS_PER_MIN` when you
need explicit per-tier ceilings; otherwise the backend falls back to
`ANALYZE_RATE_LIMIT_PER_MIN` for public keys and a higher ops default.
Authenticated BFF analyze calls may also send a hashed `x-sitejson-client`
fingerprint, which enables per-client analyze buckets controlled by
`ANALYZE_CLIENT_RATE_LIMIT_PUBLIC_PER_MIN` / `PRO_PER_MIN` / `OPS_PER_MIN`.

## Module Layout

- `src/api` — route handlers and schemas
- `src/core` — orchestrator and core types
- `src/providers` — pluggable providers
- `src/services` — use-case orchestration
- `src/storage` — repository interfaces and adapters
- `src/queue` — queue interfaces and adapters
- `src/workers` — async workers (`ingest` + `browser` + `async` + `traffic` + `whois` + `radar sync`)

## Runtime Notes

- Browser phase uses Playwright Chromium and closes `page/context/browser` in `finally`.
- Visual provider writes screenshot path/url and dominant color into report.
- Radar provider reads local snapshots and enqueues async refresh when stale.
- Radar bulk sync supports `rank,domain` / `domain,rank` / `domain-only` CSV formats.
- Taxonomy provider is Codex-first (`CODEX_API_KEY`) with IAB-style classification; fallback chain can use Moonshot/Gemini/BigModel when configured.
- Alternatives use derived search fields plus `site_alternatives_cache`; the
  public response remains `{ algorithm, items }`, while cache rows are versioned
  with `rule_based:v1`.

## Storage / Queue Drivers

- `STORAGE_DRIVER=memory|postgres`
- `QUEUE_DRIVER=memory|bullmq`

When using postgres/bullmq, set:

- `DATABASE_URL`
- `REDIS_URL`
- `REDIS_PASSWORD` (optional; used when production Redis is started with `--requirepass`)
- `QUEUE_NAME`
- `QUEUE_CONCURRENCY`
- `PG_POOL_MAX` (legacy shared fallback, default `10`)
- `PG_POOL_MAX_API` (optional API-specific override; defaults to `20` when neither pool var is set)
- `PG_POOL_MAX_WORKER` (optional worker-specific override; defaults to `50` when neither pool var is set)
- `PG_STATEMENT_TIMEOUT_MS` (default `30000`)

Production also requires `SITEJSON_API_KEY`, `SITEJSON_OPS_API_KEY`, `SIMILARWEB_API_KEY_SALT`, and a non-wildcard `CORS_ALLOWLIST` in the ops environment. API keys must be at least 32 characters and high entropy; known placeholders, repeated strings, and weak previous rotation keys are rejected at startup. Analyze, ingest, and insights rate-limited routes return `X-RateLimit-*` headers plus `X-SiteJSON-RateLimit-Tier` for easier client-side diagnosis.

## Testing

Vitest with in-memory storage/queue implementations. No external dependencies required.

```bash
npm run test           # single pass
npm run test:watch     # watch mode
npm run typecheck      # tsc --noEmit
npm run openapi:check  # generated OpenAPI drift check
npm run security:scan  # redacted secret scan
npm run build          # production TypeScript build
npm run db:explain-due-batch -- --format=json --limit=100
```

Production cleanup is explicit and dry-run first:

```bash
npm run build
npm run retention:cleanup
npm run retention:cleanup -- --apply --limit=5000
```

| Suite | Files | Tests | Location |
|-------|-------|-------|----------|
| Core/Orchestrator | 2 | 7 | `src/core/__tests__/` |
| Scoring | 1 | 7 | `src/scoring/__tests__/` |
| Workers | 6 | 23 | `src/workers/__tests__/` |
| Providers | 5 | 15 | `src/providers/__tests__/` |
| Services | 4 | 22 | `src/services/__tests__/` |
| Storage | 3 | 6 | `src/storage/__tests__/` |
| API Routes | 1 | 22 | `src/api/__tests__/` |
| **Total** | **28** | **102** | |

Integration tests (`providers-integration.spec.ts`, 21 tests) require live API keys and are skipped in CI.

## Browser Worker Single-Thread Test Mode

Use this mode when debugging Playwright/browser-lane issues and you need strict one-job-at-a-time execution.

```bash
cd backend
WORKER_QUEUES=browser \
QUEUE_DRIVER=bullmq \
STORAGE_DRIVER=postgres \
DATABASE_URL="$SITEJSON_DATABASE_URL" \
REDIS_URL='redis://127.0.0.1:6379' \
REDIS_PASSWORD="${REDIS_PASSWORD:-}" \
QUEUE_CONCURRENCY=1 \
QUEUE_CONCURRENCY_BROWSER=1 \
BROWSER_POOL_SIZE=1 \
npm run worker
```

Guidance:
- `WORKER_QUEUES=browser` starts only the browser lane in `src/worker.ts`.
- `QUEUE_CONCURRENCY_BROWSER=1` enforces one browser job at a time for BullMQ.
- `BROWSER_POOL_SIZE=1` keeps a single warm browser for predictable, production-like one-by-one runs.

For realtime-lane isolation, use `WORKER_QUEUES=browser_realtime` plus `QUEUE_CONCURRENCY_BROWSER_REALTIME` to size the user-triggered browser queue separately from background/browser drain traffic.

## Ops Dashboard API

- `GET /api/v1/ops/dashboard`
- Query:
  - `window=1h` (optional, default `1h`)
  - `recent_limit=1..100` (optional, default `20`)
- Returns aggregated queue/job/quality metrics and `recent_items` for dashboard polling.
- `queue` and `queue_by_type` now include `prioritized`, and `queue_by_type` includes `browser_realtime`.
