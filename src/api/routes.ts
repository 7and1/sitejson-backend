import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  analyzeRequestSchema,
  alternativesQuerySchema,
  directoryParamsSchema,
  ingestDomainsSchema,
  opsDashboardQuerySchema,
  retryDlqSchema,
} from './schemas.js';
import type { AnalyzeService } from '../services/analyze-service.js';
import type { IngestService } from '../services/ingest-service.js';
import type { JobRepository, SiteRepository } from '../storage/interfaces.js';
import type { JobQueue } from '../queue/interfaces.js';
import { normalizeDomain } from '../services/domain.js';
import type { OpsDashboardService } from '../services/ops-dashboard-service.js';
import type { DirectorySearchOptions, SiteReport } from '../core/types.js';
import { sanitizeSiteReport } from '../services/report-merge.js';

const VALID_PROVIDERS = [
  'visual', 'meta', 'seo', 'dns', 'ads', 'publisher',
  'files', 'traffic', 'whois', 'radar', 'ai',
] as const;

type ProviderName = (typeof VALID_PROVIDERS)[number];

const PROVIDER_EXPECTED_FIELDS: Record<ProviderName, string[]> = {
  visual: ['screenshotUrl', 'dominantColor', 'palette', 'storage'],
  meta: ['title', 'description', 'techStackDetected'],
  seo: ['h1Count', 'h2Count', 'internalLinks', 'externalLinks', 'imagesCount'],
  dns: ['provider', 'mxRecords', 'nsRecords', 'txtRecords'],
  ads: ['isAdvertiser', 'advertiserIds', 'advertiserNames', 'resultCount', 'transparencySignals'],
  publisher: ['hasAdsTxt', 'adSystems', 'directCount', 'resellerCount', 'monetizationSignals'],
  files: ['hasRobots', 'hasSitemap', 'robotsSitemapUrls'],
  traffic: ['monthlyVisits', 'globalRank', 'countryRank', 'bounceRate', 'avgVisitDuration', 'pagesPerVisit', 'topCountry', 'topRegions', 'topKeywords', 'trafficSources'],
  whois: ['whois.registrar', 'whois.createdAt', 'whois.expiresAt', 'whois.nameservers', 'whois.status', 'domainAgeYears'],
  radar: ['globalRank', 'rankBucket', 'categories', 'sourceTimestamp'],
  ai: ['taxonomy.iabCategory', 'taxonomy.iabSubCategory', 'taxonomy.confidence', 'taxonomy.tags', 'aiAnalysis.business', 'aiAnalysis.risk', 'aiAnalysis.visualAnalysis'],
};

function extractProviderData(report: SiteReport, provider: ProviderName): Record<string, unknown> | null {
  switch (provider) {
    case 'visual': return report.visual ? { ...report.visual } : null;
    case 'meta': return report.meta ? { ...report.meta } : null;
    case 'seo': return report.seo ? { ...report.seo } : null;
    case 'dns': return report.dns ? { ...report.dns } : null;
    case 'ads': return report.ads ? { ...report.ads } : null;
    case 'publisher': return report.publisher ? { ...report.publisher } : null;
    case 'files': return report.files ? { ...report.files } : null;
    case 'traffic': {
      if (!report.trafficData) return null;
      const { whois: _w, domainAgeYears: _d, ...traffic } = report.trafficData;
      return traffic as Record<string, unknown>;
    }
    case 'whois': {
      if (!report.trafficData?.whois && report.trafficData?.domainAgeYears == null) return null;
      return {
        whois: report.trafficData?.whois ?? null,
        domainAgeYears: report.trafficData?.domainAgeYears ?? null,
      };
    }
    case 'radar': return report.radar ? { ...report.radar } : null;
    case 'ai': {
      if (!report.taxonomy && !report.aiAnalysis) return null;
      return { taxonomy: report.taxonomy ?? null, aiAnalysis: report.aiAnalysis ?? null };
    }
    default: return null;
  }
}

function resolveNestedField(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return cur;
}

function getFieldCompleteness(data: Record<string, unknown> | null, expectedFields: string[]) {
  if (!data) return { total: expectedFields.length, present: 0, missing: expectedFields.length, fields: Object.fromEntries(expectedFields.map(f => [f, false])) };
  const fields: Record<string, boolean> = {};
  let present = 0;
  for (const f of expectedFields) {
    const val = resolveNestedField(data, f);
    const has = val !== undefined && val !== null;
    fields[f] = has;
    if (has) present++;
  }
  return { total: expectedFields.length, present, missing: expectedFields.length - present, fields };
}

const respondError = (traceId: string, code: string, message: string) => ({
  ok: false,
  error: { code, message },
  meta: { trace_id: traceId },
});

const PUBLIC_PATHS = new Set([
  '/api/v1/healthz',
  '/api/v1/readyz',
  '/api/v1/insights',
  '/api/docs',
  '/api/docs/',
  '/api/openapi.json',
]);

const createAuthHook = (apiKeys: string[]) => {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const requestPath = request.url.split('?', 1)[0] ?? request.url;
    if (request.method === 'OPTIONS' || PUBLIC_PATHS.has(requestPath) || requestPath.startsWith('/api/docs')) {
      return;
    }

    const authHeader = request.headers.authorization;
    const providedKey = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : (request.headers['x-api-key'] as string | undefined);

    if (!providedKey || !apiKeys.includes(providedKey)) {
      return reply.status(401).send(respondError(request.id, 'UNAUTHORIZED', 'Invalid or missing API key'));
    }
  };
};

export const registerRoutes = (
  app: FastifyInstance,
  deps: {
    analyzeService: AnalyzeService;
    ingestService: IngestService;
    opsDashboardService: OpsDashboardService;
    jobs: JobRepository;
    sites: SiteRepository;
    queue: JobQueue;
  },
  options?: {
    apiKeys?: string[];
  },
) => {
  if (options?.apiKeys?.length) {
    app.addHook('preHandler', createAuthHook(options.apiKeys));
  }

  app.post('/api/v1/sites/analyze', async (request, reply) => {
    const traceId = request.id;
    const parsed = analyzeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(respondError(traceId, 'INVALID_REQUEST', 'Body validation failed'));
    }

    try {
      const result = await deps.analyzeService.schedule(
        parsed.data.domain,
        parsed.data.force_refresh ?? false,
        parsed.data.force_ai ?? false,
        parsed.data.priority ?? 'normal',
        parsed.data.skip_ai ?? false,
      );

      if (!result.accepted && result.reason === 'JOB_ALREADY_RUNNING') {
        return reply.status(409).send(respondError(traceId, 'JOB_ALREADY_RUNNING', 'Job already in progress'));
      }

      return reply.status(202).send({
        ok: true,
        data: {
          job_id: result.jobId,
          status: result.jobId ? 'pending' : 'completed',
          priority: parsed.data.priority ?? 'normal',
          reason: result.reason,
        },
        meta: {
          trace_id: traceId,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'INVALID_DOMAIN') {
        return reply.status(400).send(respondError(traceId, 'INVALID_DOMAIN', 'Domain is not valid'));
      }

      return reply.status(500).send(respondError(traceId, 'INTERNAL_ERROR', 'Unexpected server error'));
    }
  });

  app.post('/api/v1/ingest/domains', async (request, reply) => {
    const traceId = request.id;
    const parsed = ingestDomainsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(respondError(traceId, 'INVALID_REQUEST', 'Body validation failed'));
    }

    const result = await deps.ingestService.enqueueBatch({
      domains: parsed.data.domains,
      traceId,
      source: 'api',
      priority: parsed.data.priority ?? 'normal',
      forceRefresh: parsed.data.force_refresh,
      forceAi: parsed.data.force_ai,
      skipAi: parsed.data.skip_ai,
    });

    return reply.status(202).send({
      ok: true,
      data: {
        accepted_count: result.accepted.length,
        skipped_count: result.skipped.length,
        invalid_count: result.invalid.length,
        invalid_domains: result.invalid,
      },
      meta: {
        trace_id: traceId,
      },
    });
  });

  app.get('/api/v1/sites/:domain', async (request, reply) => {
    const traceId = request.id;
    const inputDomain = String((request.params as Record<string, string>).domain ?? '').toLowerCase();
    let domain: string;
    try {
      domain = normalizeDomain(inputDomain);
    } catch {
      return reply.status(400).send(respondError(traceId, 'INVALID_DOMAIN', 'Domain is not valid'));
    }

    const report = await deps.sites.getByDomain(domain);

    if (!report) {
      return reply.status(404).send(respondError(traceId, 'SITE_NOT_FOUND', 'Site report not found'));
    }

    const sanitizedReport = sanitizeSiteReport(report);
    const ttlSec = report.freshnessTtlSec ?? 604800;
    const isStale = Date.now() - new Date(report.updatedAt).getTime() > ttlSec * 1000;

    const query = request.query as Record<string, string | undefined>;
    const showDebug = query.debug === 'true';

    return reply.send({
      ok: true,
      data: {
        domain: report.domain,
        status: 'completed',
        freshness: {
          is_stale: isStale,
          updated_at: report.updatedAt,
        },
        report: sanitizedReport,
      },
      meta: {
        trace_id: traceId,
        timing: sanitizedReport._meta?.timing,
        ...(showDebug && { debug: sanitizedReport._meta?.debug }),
      },
    });
  });

  app.get('/api/v1/sites/:domain/providers', async (request, reply) => {
    const traceId = request.id;
    const inputDomain = String((request.params as Record<string, string>).domain ?? '').toLowerCase();
    let domain: string;
    try {
      domain = normalizeDomain(inputDomain);
    } catch {
      return reply.status(400).send(respondError(traceId, 'INVALID_DOMAIN', 'Domain is not valid'));
    }

    const report = await deps.sites.getByDomain(domain);
    if (!report) {
      return reply.status(404).send(respondError(traceId, 'SITE_NOT_FOUND', 'Site report not found'));
    }

    const sanitizedReport = sanitizeSiteReport(report);
    const providers = VALID_PROVIDERS.map((name) => {
      const data = extractProviderData(sanitizedReport, name);
      const health = sanitizedReport.providerHealth?.find(h => h.provider.replace('.provider', '') === name);
      const completeness = getFieldCompleteness(data, PROVIDER_EXPECTED_FIELDS[name]);
      return {
        provider: name,
        hasData: data !== null,
        health: health ? { ok: health.ok, errorCode: health.errorCode } : null,
        completeness,
      };
    });

    return reply.send({
      ok: true,
      data: {
        domain: sanitizedReport.domain,
        updatedAt: sanitizedReport.updatedAt,
        providers,
        _meta: sanitizedReport._meta,
      },
      meta: { trace_id: traceId },
    });
  });

  app.get('/api/v1/sites/:domain/providers/:provider', async (request, reply) => {
    const traceId = request.id;
    const params = request.params as Record<string, string>;
    const inputDomain = String(params.domain ?? '').toLowerCase();
    const providerName = String(params.provider ?? '').toLowerCase() as ProviderName;

    let domain: string;
    try {
      domain = normalizeDomain(inputDomain);
    } catch {
      return reply.status(400).send(respondError(traceId, 'INVALID_DOMAIN', 'Domain is not valid'));
    }

    if (!VALID_PROVIDERS.includes(providerName)) {
      return reply.status(400).send(respondError(traceId, 'INVALID_PROVIDER', `Valid providers: ${VALID_PROVIDERS.join(', ')}`));
    }

    const report = await deps.sites.getByDomain(domain);
    if (!report) {
      return reply.status(404).send(respondError(traceId, 'SITE_NOT_FOUND', 'Site report not found'));
    }

    const sanitizedReport = sanitizeSiteReport(report);
    const data = extractProviderData(sanitizedReport, providerName);
    const health = sanitizedReport.providerHealth?.find(h => h.provider.replace('.provider', '') === providerName);
    const completeness = getFieldCompleteness(data, PROVIDER_EXPECTED_FIELDS[providerName]);

    return reply.send({
      ok: true,
      data: {
        domain: sanitizedReport.domain,
        provider: providerName,
        updatedAt: sanitizedReport.updatedAt,
        hasData: data !== null,
        health: health ? { ok: health.ok, errorCode: health.errorCode } : null,
        completeness,
        data,
      },
      meta: { trace_id: traceId },
    });
  });

  app.get('/api/v1/sites/:domain/alternatives', async (request, reply) => {
    const traceId = request.id;
    const inputDomain = String((request.params as Record<string, string>).domain ?? '').toLowerCase();
    let domain: string;
    try {
      domain = normalizeDomain(inputDomain);
    } catch {
      return reply.status(400).send(respondError(traceId, 'INVALID_DOMAIN', 'Domain is not valid'));
    }

    const parsedQuery = alternativesQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.status(400).send(respondError(traceId, 'INVALID_REQUEST', 'Invalid alternatives query'));
    }

    const alternatives = await deps.sites.findAlternatives(domain, parsedQuery.data.limit ?? 6);
    if (!alternatives) {
      return reply.status(404).send(respondError(traceId, 'SITE_NOT_FOUND', 'Site report not found'));
    }

    reply.header('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=1800');

    return reply.send({
      ok: true,
      data: alternatives,
      meta: {
        trace_id: traceId,
      },
    });
  });

  app.get('/api/v1/jobs/:jobId', async (request, reply) => {
    const traceId = request.id;
    const jobId = String((request.params as Record<string, string>).jobId ?? '');
    const job = await deps.jobs.getById(jobId);

    if (!job) {
      return reply.status(404).send(respondError(traceId, 'JOB_NOT_FOUND', 'Job not found'));
    }

    if (job.status !== 'completed' && job.status !== 'failed') {
      const retryAfterByStage: Record<string, number> = {
        browser_running: 10,
        async_running: 5,
        pending: 15,
      };
      reply.header('Retry-After', String(retryAfterByStage[job.stage ?? ''] ?? 5));
    }

    return reply.send({
      ok: true,
      data: {
        job_id: job.id,
        status: job.status,
        priority: job.priority,
        progress: job.progress,
        stage: job.stage,
        updated_at: job.updatedAt,
      },
      meta: {
        trace_id: traceId,
      },
    });
  });

  app.get('/api/v1/directory/:type/:slug', async (request, reply) => {
    const traceId = request.id;
    const parsed = directoryParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send(respondError(traceId, 'INVALID_REQUEST', 'Invalid directory route'));
    }

    const query = request.query as Record<string, string | undefined>;
    const requestedPage = Number(query.page ?? '1');
    const requestedPageSize = Number(query.page_size ?? '20');

    const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
    const pageSize = Number.isFinite(requestedPageSize) ? Math.min(100, Math.max(1, requestedPageSize)) : 20;

    const sortRaw = query.sort;
    const minScoreRaw = query.min_score ? Number(query.min_score) : undefined;
    const hasTrafficRaw = query.has_traffic === 'true';

    const options: DirectorySearchOptions = {};
    if (sortRaw === 'rank' || sortRaw === 'traffic' || sortRaw === 'score') options.sort = sortRaw;
    if (minScoreRaw !== undefined && Number.isFinite(minScoreRaw)) options.minScore = minScoreRaw;
    if (hasTrafficRaw) options.hasTraffic = true;

    const result = await deps.sites.searchDirectory(parsed.data.type, parsed.data.slug, page, pageSize, Object.keys(options).length > 0 ? options : undefined);

    return reply.send({
      ok: true,
      data: {
        items: result.items,
        pagination: {
          page,
          page_size: pageSize,
          total: result.total,
        },
        filters: {
          type: parsed.data.type,
          slug: parsed.data.slug,
        },
      },
      meta: {
        trace_id: traceId,
      },
    });
  });

  app.get('/api/v1/directory/:type/:slug/stats', async (request, reply) => {
    const traceId = request.id;
    const parsed = directoryParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send(respondError(traceId, 'INVALID_REQUEST', 'Invalid directory route'));
    }

    const stats = await deps.sites.getDirectoryStats(parsed.data.type, parsed.data.slug);

    return reply.send({
      ok: true,
      data: stats,
      meta: { trace_id: traceId },
    });
  });

  app.get('/api/v1/directory/:type', async (request, reply) => {
    const traceId = request.id;
    const type = (request.params as Record<string, string>).type;
    if (!['category', 'technology', 'topic'].includes(type)) {
      return reply.status(400).send(respondError(traceId, 'INVALID_REQUEST', 'Invalid directory type'));
    }

    const query = request.query as Record<string, string | undefined>;
    const limitRaw = Number(query.limit ?? '50');
    const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 50;

    const summary = await deps.sites.getDirectoryTypeSummary(type as 'category' | 'technology' | 'topic', limit);

    return reply.send({
      ok: true,
      data: summary,
      meta: { trace_id: traceId },
    });
  });

  app.get('/api/v1/insights', async (request, reply) => {
    const traceId = request.id;
    const insights = await deps.sites.getGlobalInsights();
    return reply.send({
      ok: true,
      data: insights,
      meta: { trace_id: traceId },
    });
  });

  app.get('/api/v1/ops/dashboard', async (request, reply) => {
    const traceId = request.id;
    const parsed = opsDashboardQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send(respondError(traceId, 'INVALID_REQUEST', 'Invalid dashboard query'));
    }

    try {
      const dashboard = await deps.opsDashboardService.getDashboard({
        window: parsed.data.window ?? '1h',
        recentLimit: parsed.data.recent_limit ?? 20,
      });

      return reply.send({
        ok: true,
        data: dashboard,
        meta: {
          trace_id: traceId,
        },
      });
    } catch {
      return reply.status(500).send(respondError(traceId, 'INTERNAL_ERROR', 'Failed to build dashboard'));
    }
  });

  app.get('/api/v1/ops/queues', async (request, reply) => {
    const traceId = request.id;
    const counts = await deps.queue.getAllCounts();

    return reply.send({
      ok: true,
      data: {
        queues: counts,
      },
      meta: {
        trace_id: traceId,
      },
    });
  });

  app.post('/api/v1/ops/retry-dlq', async (request, reply) => {
    const traceId = request.id;
    const parsed = retryDlqSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(respondError(traceId, 'INVALID_REQUEST', 'Body validation failed'));
    }

    const retried = await deps.queue.retryFailed(parsed.data.queue, parsed.data.limit ?? 100);
    return reply.send({
      ok: true,
      data: {
        queue: parsed.data.queue,
        retried_count: retried,
      },
      meta: {
        trace_id: traceId,
      },
    });
  });

  app.get('/api/v1/healthz', async () => ({ ok: true, data: { status: 'alive' } }));

  app.get('/api/v1/readyz', async (_request, reply) => {
    const [queueOk, jobsOk, sitesOk] = await Promise.all([
      deps.queue.healthCheck(),
      deps.jobs.healthCheck(),
      deps.sites.healthCheck(),
    ]);

    const ready = queueOk && jobsOk && sitesOk;
    if (!ready) {
      return reply.status(503).send({
        ok: false,
        error: {
          code: 'NOT_READY',
          message: 'Dependency health check failed',
        },
        data: {
          queue: queueOk,
          jobs: jobsOk,
          sites: sitesOk,
        },
      });
    }

    return reply.send({
      ok: true,
      data: {
        status: 'ready',
        queue: true,
        jobs: true,
        sites: true,
      },
    });
  });
};
