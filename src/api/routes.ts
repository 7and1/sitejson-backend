import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  analyzeRequestSchema,
  alternativesQuerySchema,
  directoryParamsSchema,
  ingestDomainsSchema,
  opsDashboardQuerySchema,
  retryDlqSchema,
  trafficHistoryQuerySchema,
} from './schemas.js';
import type { AnalyzeService } from '../services/analyze-service.js';
import type { IngestService } from '../services/ingest-service.js';
import type { CrawlTargetRepository, JobRepository, SiteRepository } from '../storage/interfaces.js';
import type { JobQueue } from '../queue/interfaces.js';
import { normalizeDomain } from '../services/domain.js';
import type { OpsDashboardService } from '../services/ops-dashboard-service.js';
import { buildQueueFailureAlerts } from '../services/ops-dashboard-service.js';
import type { DirectorySearchOptions, SiteReport } from '../core/types.js';
import type { TrafficHistoryService } from '../services/traffic-history-service.js';
import { guardBlockedSiteReport, sanitizeSiteReport } from '../services/report-merge.js';
import { isQueueCapacityError } from '../queue/errors.js';
import { buildSiteReportResponse } from '../services/site-report-response.js';

type AuthRole = 'public' | 'pro' | 'ops';
type RateLimitTier = AuthRole | 'anonymous';

type AuthContext = {
  role: AuthRole;
  keyHash: string;
};

type AuthedRequest = FastifyRequest & {
  sitejsonAuth?: AuthContext;
};

type RateLimitBucket = {
  resetAt: number;
  remaining: number;
};

type RateLimitPolicy = {
  public: number;
  pro?: number;
  ops: number;
  anonymous?: number;
};

type RateLimitResult =
  | {
    allowed: true;
    limit: number;
    remaining: number;
    resetAt: number;
  }
  | {
    allowed: false;
    limit: number;
    remaining: 0;
    resetAt: number;
    retryAfterSec: number;
  };

const VALID_PROVIDERS = [
  'visual', 'meta', 'seo', 'dns', 'ads', 'publisher',
  'files', 'authority', 'traffic', 'whois', 'radar', 'ai',
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
  authority: ['domainRating', 'source', 'licenseUrl', 'attribution', 'fetchedAt'],
  traffic: ['monthlyVisits', 'globalRank', 'countryRank', 'bounceRate', 'avgVisitDuration', 'pagesPerVisit', 'dataYear', 'dataMonth', 'isStale', 'dataAgeDays', 'snapshotDate', 'cachedAt', 'topCountry', 'topRegions', 'topKeywords', 'trafficSources'],
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
    case 'authority': return report.authority ? { ...report.authority } : null;
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

function hasMeaningfulProviderValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasMeaningfulProviderValue);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(hasMeaningfulProviderValue);
  return true;
}

function getFieldCompleteness(data: Record<string, unknown> | null, expectedFields: string[]) {
  if (!data) return { total: expectedFields.length, present: 0, missing: expectedFields.length, fields: Object.fromEntries(expectedFields.map(f => [f, false])) };
  const fields: Record<string, boolean> = {};
  let present = 0;
  for (const f of expectedFields) {
    const val = resolveNestedField(data, f);
    const has = hasMeaningfulProviderValue(val);
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

const keyHash = (value: string): string => (
  createHash('sha256').update(value).digest('hex')
);

const secureStringEquals = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(keyHash(left), 'hex');
  const rightBuffer = Buffer.from(keyHash(right), 'hex');
  return timingSafeEqual(leftBuffer, rightBuffer);
};

const findMatchingKey = (providedKey: string, keys: string[]): string | null => {
  for (const key of keys) {
    if (secureStringEquals(providedKey, key)) {
      return key;
    }
  }
  return null;
};

const requestAuth = (request: FastifyRequest): AuthContext | undefined => (
  (request as AuthedRequest).sitejsonAuth
);

const isOpsRequest = (request: FastifyRequest): boolean => requestAuth(request)?.role === 'ops';

// Privileged analyze options (priority:'high', force_refresh, force_ai) are
// allowed for both the ops tier and the dedicated pro tier; only /ops/* control
// endpoints remain ops-only (enforced in the auth hook).
const isPrivilegedAnalyzeAllowed = (request: FastifyRequest): boolean => {
  const role = requestAuth(request)?.role;
  return role === 'ops' || role === 'pro';
};

const hasPrivilegedAnalyzeOptions = (input: {
  force_refresh?: boolean;
  force_ai?: boolean;
  priority?: 'normal' | 'high';
}): boolean => (
  input.force_refresh === true
  || input.force_ai === true
  || input.priority === 'high'
);

const resolveRateLimitTier = (request: FastifyRequest): RateLimitTier => (
  requestAuth(request)?.role ?? 'anonymous'
);

const resolveRateLimitLimit = (request: FastifyRequest, policy: RateLimitPolicy): number => {
  const tier = resolveRateLimitTier(request);
  if (tier === 'ops') {
    return policy.ops;
  }
  if (tier === 'pro') {
    return policy.pro ?? policy.public;
  }
  if (tier === 'public') {
    return policy.public;
  }
  return policy.anonymous ?? policy.public;
};

const resolveRateLimitBucketKey = (request: FastifyRequest, prefix: string): string => {
  const auth = requestAuth(request);
  const identity = auth?.keyHash ?? request.ip ?? 'unknown';
  return `${prefix}:${resolveRateLimitTier(request)}:${identity}`;
};

const TRUSTED_CLIENT_FINGERPRINT_PATTERN = /^[a-f0-9]{16}$/u;

const resolveTrustedAnalyzeClient = (request: FastifyRequest): string | null => {
  if (!requestAuth(request)) {
    return null;
  }

  const header = request.headers['x-sitejson-client'];
  if (typeof header !== 'string' || !TRUSTED_CLIENT_FINGERPRINT_PATTERN.test(header)) {
    return null;
  }

  return header;
};

const resolveAnalyzeClientBucketKey = (request: FastifyRequest, clientFingerprint: string): string => {
  const auth = requestAuth(request);
  const identity = auth?.keyHash ?? 'unknown';
  return `analyze-client:${resolveRateLimitTier(request)}:${identity}:${clientFingerprint}`;
};

const setRateLimitHeaders = (
  reply: FastifyReply,
  rateLimit: RateLimitResult,
  tier: RateLimitTier,
): void => {
  reply.header('X-RateLimit-Limit', String(rateLimit.limit));
  reply.header('X-RateLimit-Remaining', String(rateLimit.remaining));
  reply.header('X-RateLimit-Reset', String(Math.ceil(rateLimit.resetAt / 1000)));
  reply.header('X-SiteJSON-RateLimit-Tier', tier);
  if (!rateLimit.allowed) {
    reply.header('Retry-After', String(rateLimit.retryAfterSec));
  }
};

const createRateLimiter = () => {
  const buckets = new Map<string, RateLimitBucket>();
  let lastCleanupAt = 0;

  return (bucketKey: string, limit: number, now = Date.now()): RateLimitResult => {
    const safeLimit = Math.max(1, Math.trunc(limit));

    if (now - lastCleanupAt >= 120_000) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) {
          buckets.delete(key);
        }
      }
      lastCleanupAt = now;
    }

    const existing = buckets.get(bucketKey);

    if (!existing || existing.resetAt <= now) {
      buckets.set(bucketKey, {
        resetAt: now + 60_000,
        remaining: safeLimit - 1,
      });
      return {
        allowed: true,
        limit: safeLimit,
        remaining: safeLimit - 1,
        resetAt: now + 60_000,
      };
    }

    if (existing.remaining <= 0) {
      return {
        allowed: false,
        limit: safeLimit,
        remaining: 0,
        resetAt: existing.resetAt,
        retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }

    existing.remaining -= 1;
    return {
      allowed: true,
      limit: safeLimit,
      remaining: existing.remaining,
      resetAt: existing.resetAt,
    };
  };
};

const BASE_PUBLIC_PATHS = new Set([
  '/api/v1/healthz',
  '/api/v1/readyz',
  '/api/v1/insights',
]);

const DOCS_PUBLIC_PATHS = new Set([
  '/api/docs',
  '/api/docs/',
  '/api/openapi.json',
]);

const createAuthHook = (apiKeys: string[], opsApiKeys: string[], proApiKeys: string[], options?: { exposeApiDocs?: boolean }) => {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const requestPath = request.url.split('?', 1)[0] ?? request.url;
    const isPublicDocsPath = DOCS_PUBLIC_PATHS.has(requestPath) || requestPath.startsWith('/api/docs');
    if (
      request.method === 'OPTIONS'
      || BASE_PUBLIC_PATHS.has(requestPath)
      || requestPath.startsWith('/snapshots/')
      || (options?.exposeApiDocs === true && isPublicDocsPath)
    ) {
      return;
    }

    const authHeader = request.headers.authorization;
    const providedKey = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : (request.headers['x-api-key'] as string | undefined);

    if (!providedKey) {
      return reply.status(401).send(respondError(request.id, 'UNAUTHORIZED', 'Invalid or missing API key'));
    }

    const matchedOpsKey = findMatchingKey(providedKey, opsApiKeys);
    if (matchedOpsKey) {
      (request as AuthedRequest).sitejsonAuth = {
        role: 'ops',
        keyHash: keyHash(matchedOpsKey),
      };
      return;
    }

    const matchedProKey = findMatchingKey(providedKey, proApiKeys);
    if (matchedProKey) {
      // Pro tier: may use privileged analyze options, but is denied /ops/* control.
      if (requestPath.startsWith('/api/v1/ops/')) {
        return reply.status(403).send(respondError(request.id, 'FORBIDDEN', 'Ops API key required'));
      }

      (request as AuthedRequest).sitejsonAuth = {
        role: 'pro',
        keyHash: keyHash(matchedProKey),
      };
      return;
    }

    const matchedApiKey = findMatchingKey(providedKey, apiKeys);
    if (matchedApiKey) {
      if (requestPath.startsWith('/api/v1/ops/')) {
        return reply.status(403).send(respondError(request.id, 'FORBIDDEN', 'Ops API key required'));
      }

      (request as AuthedRequest).sitejsonAuth = {
        role: 'public',
        keyHash: keyHash(matchedApiKey),
      };
      return;
    }

    return reply.status(401).send(respondError(request.id, 'UNAUTHORIZED', 'Invalid or missing API key'));
  };
};

export const registerRoutes = (
  app: FastifyInstance,
  deps: {
    analyzeService: AnalyzeService;
    ingestService: IngestService;
    trafficHistoryService?: TrafficHistoryService | null;
    opsDashboardService: OpsDashboardService;
    jobs: JobRepository;
    sites: SiteRepository;
    crawlTargets?: CrawlTargetRepository;
    queue: JobQueue;
  },
  options?: {
    apiKeys?: string[];
    opsApiKeys?: string[];
    proApiKeys?: string[];
    exposeApiDocs?: boolean;
    analyzeRateLimits?: RateLimitPolicy;
    analyzeClientRateLimits?: RateLimitPolicy;
    ingestRateLimits?: RateLimitPolicy;
    insightsRateLimitPerMinute?: number;
    ingestMaxDomains?: number;
  },
) => {
  if (options?.apiKeys?.length) {
    app.addHook('preHandler', createAuthHook(
      options.apiKeys,
      options.opsApiKeys ?? [],
      options.proApiKeys ?? [],
      { exposeApiDocs: options.exposeApiDocs },
    ));
  }

  // Rate limiters are scoped per registerRoutes instance so that separate
  // Fastify apps (e.g. each test case) get isolated buckets. Production builds
  // one app per process, so this preserves the prior single-limiter behavior.
  const analyzeRateLimiter = createRateLimiter();
  const analyzeClientRateLimiter = createRateLimiter();
  const ingestRateLimiter = createRateLimiter();
  const insightsRateLimiter = createRateLimiter();

  app.post('/api/v1/sites/analyze', async (request, reply) => {
    const traceId = request.id;
    const parsed = analyzeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(respondError(traceId, 'INVALID_REQUEST', 'Body validation failed'));
    }

    if (hasPrivilegedAnalyzeOptions(parsed.data) && !isPrivilegedAnalyzeAllowed(request)) {
      return reply.status(403).send(respondError(traceId, 'FORBIDDEN', 'Ops or pro API key required for privileged analyze options'));
    }

    const tier = resolveRateLimitTier(request);
    const limit = resolveRateLimitLimit(request, options?.analyzeRateLimits ?? { public: 60, pro: 120, ops: 300 });
    const trustedClient = resolveTrustedAnalyzeClient(request);
    if (trustedClient) {
      const aggregateRateLimit = limit > 0
        ? analyzeRateLimiter(resolveRateLimitBucketKey(request, 'analyze'), limit)
        : null;
      const clientLimit = resolveRateLimitLimit(request, options?.analyzeClientRateLimits ?? { public: 20, pro: 120, ops: 300 });
      const clientRateLimit = clientLimit > 0
        ? analyzeClientRateLimiter(resolveAnalyzeClientBucketKey(request, trustedClient), clientLimit)
        : null;

      if (clientRateLimit) {
        setRateLimitHeaders(reply, clientRateLimit, tier);
      } else if (aggregateRateLimit) {
        setRateLimitHeaders(reply, aggregateRateLimit, tier);
      }

      if (aggregateRateLimit && !aggregateRateLimit.allowed) {
        reply.header('Retry-After', String(aggregateRateLimit.retryAfterSec));
        return reply.status(429).send(respondError(traceId, 'RATE_LIMITED', 'Analyze rate limit exceeded'));
      }
      if (clientRateLimit && !clientRateLimit.allowed) {
        return reply.status(429).send(respondError(traceId, 'RATE_LIMITED', 'Analyze rate limit exceeded'));
      }
    } else if (limit > 0) {
      const bucketKey = resolveRateLimitBucketKey(request, 'analyze');
      const rateLimit = analyzeRateLimiter(bucketKey, limit);
      setRateLimitHeaders(reply, rateLimit, tier);
      if (!rateLimit.allowed) {
        return reply.status(429).send(respondError(traceId, 'RATE_LIMITED', 'Analyze rate limit exceeded'));
      }
    }

    try {
      const domain = normalizeDomain(parsed.data.domain);
      const result = await deps.analyzeService.schedule(
        domain,
        parsed.data.force_refresh ?? false,
        parsed.data.force_ai ?? false,
        parsed.data.priority ?? 'normal',
        parsed.data.skip_ai ?? false,
        parsed.data.webhook_url,
      );
      const [completedReport, completedTarget] = result.reason === 'ALREADY_FRESH' && result.jobId === null
        ? await Promise.all([
            deps.sites.getByDomain(domain),
            deps.crawlTargets?.getByDomain(domain) ?? Promise.resolve(null),
          ])
        : [null, null];
      const completedPayload = completedReport
        ? await buildSiteReportResponse({ crawlTarget: completedTarget }, completedReport)
        : null;

      return reply.status(202).send({
        ok: true,
        data: {
          job_id: result.jobId,
          status: result.jobId ? 'pending' : 'completed',
          priority: parsed.data.priority ?? 'normal',
          reason: result.reason,
          ...(completedPayload ? {
            freshness: completedPayload.data.freshness,
            enrichment: completedPayload.data.enrichment,
            report: completedPayload.data.report,
          } : {}),
        },
        meta: {
          trace_id: traceId,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'INVALID_DOMAIN') {
        return reply.status(400).send(respondError(traceId, 'INVALID_DOMAIN', 'Domain is not valid'));
      }

      if (isQueueCapacityError(error)) {
        return reply.status(503).send(respondError(traceId, 'QUEUE_OVERLOADED', 'Queue capacity is temporarily exhausted. Retry soon.'));
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

    const maxDomains = Math.max(1, Math.trunc(options?.ingestMaxDomains ?? 100));
    if (parsed.data.domains.length > maxDomains) {
      return reply.status(400).send(respondError(traceId, 'INVALID_REQUEST', `Too many domains; maximum is ${maxDomains}`));
    }

    if (hasPrivilegedAnalyzeOptions(parsed.data) && !isPrivilegedAnalyzeAllowed(request)) {
      return reply.status(403).send(respondError(traceId, 'FORBIDDEN', 'Ops or pro API key required for privileged ingest options'));
    }

    const ingestLimit = resolveRateLimitLimit(request, options?.ingestRateLimits ?? { public: 60, pro: 120, ops: 120 });
    if (ingestLimit > 0) {
      const bucketKey = resolveRateLimitBucketKey(request, 'ingest');
      const rateLimit = ingestRateLimiter(bucketKey, ingestLimit);
      setRateLimitHeaders(reply, rateLimit, resolveRateLimitTier(request));
      if (!rateLimit.allowed) {
        return reply.status(429).send(respondError(traceId, 'RATE_LIMITED', 'Ingest rate limit exceeded'));
      }
    }

    try {
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
    } catch (error) {
      if (isQueueCapacityError(error)) {
        return reply.status(503).send(respondError(traceId, 'QUEUE_OVERLOADED', 'Queue capacity is temporarily exhausted. Retry soon.'));
      }

      return reply.status(500).send(respondError(traceId, 'INTERNAL_ERROR', 'Unexpected server error'));
    }
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

    const [report, crawlTarget] = await Promise.all([
      deps.sites.getByDomain(domain),
      deps.crawlTargets?.getByDomain(domain) ?? Promise.resolve(null),
    ]);

    if (!report) {
      return reply.status(404).send(respondError(traceId, 'SITE_NOT_FOUND', 'Site report not found'));
    }

    const query = request.query as Record<string, string | undefined>;
    const showDebug = query.debug === 'true' && isOpsRequest(request);
    const sitePayload = await buildSiteReportResponse({ crawlTarget }, report);

    if (sitePayload.data.enrichment.pending) {
      reply.header('cache-control', 'no-store');
    } else if (!showDebug) {
      // Public report payloads are identical for every caller; let edges reuse them
      // briefly so page views stop paying an origin round-trip on every hit.
      reply.header('cache-control', 'public, s-maxage=120, stale-while-revalidate=600');
    }

    return reply.send({
      ok: true,
      data: sitePayload.data,
      meta: {
        trace_id: traceId,
        timing: sitePayload.sanitizedReport._meta?.timing,
        ...(showDebug && { debug: sitePayload.sanitizedReport._meta?.debug }),
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

    const sanitizedReport = guardBlockedSiteReport(sanitizeSiteReport(report));
    const providers = VALID_PROVIDERS.map((name) => {
      const data = extractProviderData(sanitizedReport, name);
      const health = sanitizedReport.providerHealth?.find(h => h.provider.replace('.provider', '') === name);
      const completeness = getFieldCompleteness(data, PROVIDER_EXPECTED_FIELDS[name]);
      return {
        provider: name,
        hasData: completeness.present > 0,
        health: health ? { ok: health.ok, errorCode: health.errorCode } : null,
        completeness,
      };
    }).filter((item) => item.provider !== 'authority' || item.hasData || item.health);

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

    const sanitizedReport = guardBlockedSiteReport(sanitizeSiteReport(report));
    const data = extractProviderData(sanitizedReport, providerName);
    const health = sanitizedReport.providerHealth?.find(h => h.provider.replace('.provider', '') === providerName);
    const completeness = getFieldCompleteness(data, PROVIDER_EXPECTED_FIELDS[providerName]);

    return reply.send({
      ok: true,
      data: {
        domain: sanitizedReport.domain,
        provider: providerName,
        updatedAt: sanitizedReport.updatedAt,
        hasData: completeness.present > 0,
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

  app.get('/api/v1/sites/:domain/traffic-history', async (request, reply) => {
    const traceId = request.id;
    const inputDomain = String((request.params as Record<string, string>).domain ?? '').toLowerCase();
    let domain: string;
    try {
      domain = normalizeDomain(inputDomain);
    } catch {
      return reply.status(400).send(respondError(traceId, 'INVALID_DOMAIN', 'Domain is not valid'));
    }

    const parsedQuery = trafficHistoryQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.status(400).send(respondError(traceId, 'INVALID_REQUEST', 'Invalid traffic history query'));
    }

    if (!deps.trafficHistoryService?.isConfigured()) {
      return reply.status(503).send(respondError(traceId, 'TRAFFIC_HISTORY_UNAVAILABLE', 'Traffic history is not configured'));
    }

    const history = await deps.trafficHistoryService.getHistory(domain, parsedQuery.data);
    if (!history) {
      return reply.status(404).send(respondError(traceId, 'TRAFFIC_HISTORY_NOT_FOUND', 'Traffic history not found'));
    }

    reply.header('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    return reply.send({
      ok: true,
      data: history,
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
        ...(job.status === 'failed' && job.errorMessage
          ? { error: { code: 'JOB_FAILED', message: job.errorMessage } }
          : {}),
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

    reply.header('cache-control', 'public, s-maxage=600, stale-while-revalidate=1800');

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

    reply.header('cache-control', 'public, s-maxage=600, stale-while-revalidate=1800');

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

    reply.header('cache-control', 'public, s-maxage=600, stale-while-revalidate=1800');

    return reply.send({
      ok: true,
      data: summary,
      meta: { trace_id: traceId },
    });
  });

  app.get('/api/v1/insights', async (request, reply) => {
    const traceId = request.id;
    const limit = options?.insightsRateLimitPerMinute ?? 120;
    if (limit > 0) {
      const bucketKey = `insights:${request.ip || 'unknown'}`;
      const rateLimit = insightsRateLimiter(bucketKey, limit);
      setRateLimitHeaders(reply, rateLimit, 'anonymous');
      if (!rateLimit.allowed) {
        return reply.status(429).send(respondError(traceId, 'RATE_LIMITED', 'Insights rate limit exceeded'));
      }
    }

    const insights = await deps.sites.getGlobalInsights();
    reply.header('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=3600');
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
        alerts: buildQueueFailureAlerts(counts),
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
