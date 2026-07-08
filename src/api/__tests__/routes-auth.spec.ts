import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../routes.js';
import type { AnalyzeService } from '../../services/analyze-service.js';
import type { IngestService } from '../../services/ingest-service.js';
import { OpsDashboardService } from '../../services/ops-dashboard-service.js';
import { InMemoryCrawlTargetRepository, InMemoryJobRepository, InMemorySiteRepository } from '../../storage/in-memory.js';
import { InMemoryJobQueue } from '../../queue/in-memory.js';
import { QueueCapacityError } from '../../queue/errors.js';

const createAppWithAuth = (options?: { exposeApiDocs?: boolean }) => {
  const app = Fastify();
  const jobs = new InMemoryJobRepository();
  const sites = new InMemorySiteRepository();
  const crawlTargets = new InMemoryCrawlTargetRepository();
  const queue = new InMemoryJobQueue();
  const opsDashboardService = new OpsDashboardService(jobs, queue);

  registerRoutes(app, {
    analyzeService: {} as AnalyzeService,
    ingestService: {} as IngestService,
    opsDashboardService,
    jobs,
    sites,
    crawlTargets,
    queue,
}, {
    apiKeys: ['test-api-key'],
    opsApiKeys: ['test-ops-key'],
    exposeApiDocs: options?.exposeApiDocs,
  });

  return app;
};

const createAppWithCustomOptions = (options: Parameters<typeof registerRoutes>[2]) => {
  const app = Fastify();
  const jobs = new InMemoryJobRepository();
  const sites = new InMemorySiteRepository();
  const crawlTargets = new InMemoryCrawlTargetRepository();
  const queue = new InMemoryJobQueue();
  const opsDashboardService = new OpsDashboardService(jobs, queue);

  registerRoutes(app, {
    analyzeService: {} as AnalyzeService,
    ingestService: {} as IngestService,
    opsDashboardService,
    jobs,
    sites,
    crawlTargets,
    queue,
  }, options);

  return app;
};

describe('registerRoutes auth hook', () => {
  it('allows public healthz with query string', async () => {
    const app = createAppWithAuth();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/healthz?x=1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: { status: 'alive' },
    });

    await app.close();
  });

  it('still protects non-public routes without api key', async () => {
    const app = createAppWithAuth();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/jobs/test-job-id',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');

    await app.close();
  });

  it('rejects dashboard route with regular api key', async () => {
    const app = createAppWithAuth();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ops/dashboard?window=1h&recent_limit=10',
      headers: {
        'x-api-key': 'test-api-key',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');

    await app.close();
  });

  it('allows dashboard route with ops api key', async () => {
    const app = createAppWithAuth();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ops/dashboard?window=1h&recent_limit=10',
      headers: {
        'x-api-key': 'test-ops-key',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
    expect(response.json().data.window).toBe('1h');
    expect(response.json().data.alerts).toEqual([]);

    await app.close();
  });

  it('includes failed-queue alerts on ops queues response', async () => {
    const isolatedApp = Fastify();
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const queue = new InMemoryJobQueue();
    queue.getAllCounts = async () => ({
      ingest: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 },
      browser_realtime: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 },
      browser: { waiting: 0, active: 0, completed: 0, failed: 2, delayed: 0, prioritized: 0 },
      async: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 },
      radar: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 },
      traffic: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 },
      whois: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 },
    });
    const opsDashboardService = new OpsDashboardService(jobs, queue);

    registerRoutes(isolatedApp, {
      analyzeService: {} as AnalyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
    });

    const response = await isolatedApp.inject({
      method: 'GET',
      url: '/api/v1/ops/queues',
      headers: {
        'x-api-key': 'test-ops-key',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.alerts).toEqual([
      expect.objectContaining({
        code: 'QUEUE_FAILED_JOBS',
        queue: 'browser',
        failed: 2,
      }),
    ]);

    await isolatedApp.close();
  });

  it('allows public docs routes without api key', async () => {
    const app = createAppWithAuth({ exposeApiDocs: true });

    const docsResponse = await app.inject({
      method: 'GET',
      url: '/api/docs',
    });

    const openapiResponse = await app.inject({
      method: 'GET',
      url: '/api/openapi.json',
    });

    expect(docsResponse.statusCode).not.toBe(401);
    expect(openapiResponse.statusCode).not.toBe(401);

    await app.close();
  });

  it('keeps insights public but rate-limits and edge-caches it', async () => {
    const app = createAppWithCustomOptions({
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
      insightsRateLimitPerMinute: 2,
    });

    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/insights',
    });
    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/insights',
    });
    const third = await app.inject({
      method: 'GET',
      url: '/api/v1/insights',
    });

    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('public, s-maxage=3600, stale-while-revalidate=3600');
    expect(first.headers['x-ratelimit-limit']).toBe('2');
    expect(first.headers['x-sitejson-ratelimit-tier']).toBe('anonymous');
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.headers['retry-after']).toBeDefined();
    expect(third.json().error.code).toBe('RATE_LIMITED');

    await app.close();
  });

  it('rejects invalid dashboard query', async () => {
    const app = createAppWithAuth();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ops/dashboard?window=24h',
      headers: {
        'x-api-key': 'test-ops-key',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');

    await app.close();
  });

  it('returns alternatives for existing site with api key', async () => {
    const siteRepo = new InMemorySiteRepository();
    await siteRepo.upsert({
      domain: 'target.com',
      updatedAt: new Date().toISOString(),
      meta: { title: 'Target' },
      taxonomy: { iabCategory: 'Technology', tags: ['saas', 'project-management'] },
      radar: { globalRank: 1000 },
    });
    await siteRepo.upsert({
      domain: 'alt1.com',
      updatedAt: new Date().toISOString(),
      meta: { title: 'Alt One', techStackDetected: ['react'] },
      taxonomy: { iabCategory: 'Technology', tags: ['saas', 'tasks'] },
      radar: { globalRank: 1200 },
    });
    await siteRepo.upsert({
      domain: 'alt2.com',
      updatedAt: new Date().toISOString(),
      meta: { title: 'Alt Two', techStackDetected: ['vue'] },
      taxonomy: { iabCategory: 'Technology', tags: ['project-management'] },
      radar: { globalRank: 900 },
    });

    const isolatedApp = Fastify();
    const jobs = new InMemoryJobRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    registerRoutes(isolatedApp, {
      analyzeService: {} as AnalyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites: siteRepo,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
    });

    const alternativesResponse = await isolatedApp.inject({
      method: 'GET',
      url: '/api/v1/sites/target.com/alternatives?limit=2',
      headers: {
        'x-api-key': 'test-api-key',
      },
    });

    expect(alternativesResponse.statusCode).toBe(200);
    const payload = alternativesResponse.json();
    expect(payload.ok).toBe(true);
    expect(payload.data.algorithm).toBe('semantic_embedding');
    expect(payload.data.items.length).toBe(2);
    expect(payload.data.items[0].domain).not.toBe('target.com');

    await isolatedApp.close();
  });

  it('treats empty provider payload fields as missing in provider summaries', async () => {
    const siteRepo = new InMemorySiteRepository();
    await siteRepo.upsert({
      domain: 'example.com',
      updatedAt: new Date().toISOString(),
      meta: {
        title: '',
        description: '   ',
        techStackDetected: [],
      },
      aiAnalysis: {
        business: { summary: '' },
        risk: {},
        visualAnalysis: { designStyle: '   ' },
      },
      providerHealth: [
        { provider: 'meta.provider', ok: false, errorCode: 'EMPTY_PAYLOAD' },
        { provider: 'ai.provider', ok: false, errorCode: 'EMPTY_PAYLOAD' },
      ],
    });

    const isolatedApp = Fastify();
    const jobs = new InMemoryJobRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    registerRoutes(isolatedApp, {
      analyzeService: {} as AnalyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites: siteRepo,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
    });

    const providersResponse = await isolatedApp.inject({
      method: 'GET',
      url: '/api/v1/sites/example.com/providers',
      headers: {
        'x-api-key': 'test-api-key',
      },
    });

    expect(providersResponse.statusCode).toBe(200);
    const metaProvider = providersResponse.json().data.providers.find((item: { provider: string }) => item.provider === 'meta');
    expect(metaProvider).toMatchObject({
      hasData: false,
      health: { ok: false, errorCode: 'EMPTY_PAYLOAD' },
      completeness: {
        total: 3,
        present: 0,
        missing: 3,
        fields: {
          title: false,
          description: false,
          techStackDetected: false,
        },
      },
    });
    const aiProvider = providersResponse.json().data.providers.find((item: { provider: string }) => item.provider === 'ai');
    expect(aiProvider).toMatchObject({
      hasData: false,
      health: { ok: false, errorCode: 'EMPTY_PAYLOAD' },
      completeness: {
        total: 7,
        present: 0,
        missing: 7,
        fields: {
          'taxonomy.iabCategory': false,
          'taxonomy.iabSubCategory': false,
          'taxonomy.confidence': false,
          'taxonomy.tags': false,
          'aiAnalysis.business': false,
          'aiAnalysis.risk': false,
          'aiAnalysis.visualAnalysis': false,
        },
      },
    });

    await isolatedApp.close();
  });

  it('exposes authority and history provider data and omits them from summary when absent and not run', async () => {
    const siteRepo = new InMemorySiteRepository();
    await siteRepo.upsert({
      domain: 'example.com',
      updatedAt: new Date().toISOString(),
      authority: {
        domainRating: 93,
        source: 'ahrefs',
        licenseUrl: 'https://ahrefs.com/legal/domain-rating-license',
        attribution: 'Domain Rating by Ahrefs',
        fetchedAt: '2026-06-14T00:00:00.000Z',
      },
      history: {
        status: 'ready',
        source: 'archiverisk',
        cacheHit: true,
        archiveScore: 83,
        archiveScoreBand: 'clean',
        archiveVerdict: 'likely_clean',
        label: 'Real business',
        language: 'English',
        sensitiveWords: [],
        riskFlags: ['real_business'],
        firstCaptureYear: 2012,
        lastCaptureYear: 2026,
        historyAgeMonths: 120,
        longestStreakYears: 10,
        distinctBuildingYears: 8,
        recentYearsBuilt: 5,
        capturesCount: 14,
        yearHistogram: [{ year: 2026, count: 2 }],
        titles: [{
          year: 2026,
          timestamp: '20260101120000',
          title: 'Example',
          archiveUrl: 'https://web.archive.org/web/20260101120000/https://example.com',
        }],
        computedAt: '2026-07-06T00:00:00.000Z',
      },
      providerHealth: [
        { provider: 'authority.provider', ok: true },
        { provider: 'history.provider', ok: true },
      ],
    });
    await siteRepo.upsert({
      domain: 'missing-authority.com',
      updatedAt: new Date().toISOString(),
      providerHealth: [],
    });

    const isolatedApp = Fastify();
    const jobs = new InMemoryJobRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    registerRoutes(isolatedApp, {
      analyzeService: {} as AnalyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites: siteRepo,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
    });

    const providersResponse = await isolatedApp.inject({
      method: 'GET',
      url: '/api/v1/sites/example.com/providers',
      headers: { 'x-api-key': 'test-api-key' },
    });
    expect(providersResponse.statusCode).toBe(200);
    const authorityProvider = providersResponse.json().data.providers.find((item: { provider: string }) => item.provider === 'authority');
    expect(authorityProvider).toMatchObject({
      hasData: true,
      health: { ok: true },
      completeness: {
        total: 5,
        present: 5,
        missing: 0,
      },
    });
    const historyProvider = providersResponse.json().data.providers.find((item: { provider: string }) => item.provider === 'history');
    expect(historyProvider).toMatchObject({
      hasData: true,
      health: { ok: true },
      completeness: {
        total: 7,
        present: 7,
        missing: 0,
      },
    });

    const detailResponse = await isolatedApp.inject({
      method: 'GET',
      url: '/api/v1/sites/example.com/providers/authority',
      headers: { 'x-api-key': 'test-api-key' },
    });
    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json().data.data).toMatchObject({
      domainRating: 93,
      attribution: 'Domain Rating by Ahrefs',
    });

    const historyDetailResponse = await isolatedApp.inject({
      method: 'GET',
      url: '/api/v1/sites/example.com/providers/history',
      headers: { 'x-api-key': 'test-api-key' },
    });
    expect(historyDetailResponse.statusCode).toBe(200);
    expect(historyDetailResponse.json().data.data).toMatchObject({
      archiveVerdict: 'likely_clean',
      archiveScore: 83,
      titles: [expect.objectContaining({ title: 'Example' })],
    });

    const absentResponse = await isolatedApp.inject({
      method: 'GET',
      url: '/api/v1/sites/missing-authority.com/providers',
      headers: { 'x-api-key': 'test-api-key' },
    });
    expect(absentResponse.statusCode).toBe(200);
    expect(absentResponse.json().data.providers.some((item: { provider: string }) => item.provider === 'authority')).toBe(false);
    expect(absentResponse.json().data.providers.some((item: { provider: string }) => item.provider === 'history')).toBe(false);

    await isolatedApp.close();
  });

  it('returns pending enrichment and no-store for fresh browser reports with unfinished layers', async () => {
    const app = Fastify();
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const crawlTargets = new InMemoryCrawlTargetRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    const now = new Date().toISOString();
    await sites.upsert({
      domain: 'fresh-pending.com',
      updatedAt: now,
      meta: { title: 'Fresh Pending' },
    });
    await crawlTargets.update('fresh-pending.com', {
      lastBrowserStatus: 'success',
      lastBrowserAt: now,
    });

    registerRoutes(app, {
      analyzeService: {} as AnalyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites,
      crawlTargets,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/sites/fresh-pending.com',
      headers: { 'x-api-key': 'test-api-key' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().data.enrichment).toEqual({
      pending: true,
      pending_layers: ['async_ai', 'traffic', 'whois'],
    });

    await app.close();
  });

  it('returns completed enrichment and public cache after async, traffic, and whois catch up', async () => {
    const app = Fastify();
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const crawlTargets = new InMemoryCrawlTargetRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    const browserAt = new Date().toISOString();
    const caughtUpAt = new Date(Date.now() + 1000).toISOString();
    await sites.upsert({
      domain: 'fresh-done.com',
      updatedAt: browserAt,
      meta: { title: 'Fresh Done' },
    });
    await crawlTargets.update('fresh-done.com', {
      lastBrowserStatus: 'success',
      lastBrowserAt: browserAt,
      lastAsyncStatus: 'success',
      lastAsyncAt: caughtUpAt,
      taxonomyUpdatedAt: caughtUpAt,
      lastTrafficAt: caughtUpAt,
      lastWhoisAt: caughtUpAt,
    });

    registerRoutes(app, {
      analyzeService: {} as AnalyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites,
      crawlTargets,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/sites/fresh-done.com',
      headers: { 'x-api-key': 'test-api-key' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, s-maxage=120, stale-while-revalidate=600');
    expect(response.json().data.enrichment).toEqual({
      pending: false,
      pending_layers: [],
    });

    await app.close();
  });

  it('does not infer pending enrichment for stale reports or missing crawl targets', async () => {
    const app = Fastify();
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const crawlTargets = new InMemoryCrawlTargetRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await sites.upsert({
      domain: 'stale-report.com',
      updatedAt: old,
      freshnessTtlSec: 60,
      meta: { title: 'Stale Report' },
    });
    await crawlTargets.update('stale-report.com', {
      lastBrowserStatus: 'success',
      lastBrowserAt: now,
    });
    await sites.upsert({
      domain: 'target-missing.com',
      updatedAt: now,
      meta: { title: 'Missing Target' },
    });

    registerRoutes(app, {
      analyzeService: {} as AnalyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites,
      crawlTargets,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
    });

    const staleResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/sites/stale-report.com',
      headers: { 'x-api-key': 'test-api-key' },
    });
    const missingTargetResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/sites/target-missing.com',
      headers: { 'x-api-key': 'test-api-key' },
    });

    expect(staleResponse.statusCode).toBe(200);
    expect(staleResponse.json().data.enrichment).toEqual({
      pending: false,
      pending_layers: [],
    });
    expect(missingTargetResponse.statusCode).toBe(200);
    expect(missingTargetResponse.json().data.enrichment).toEqual({
      pending: false,
      pending_layers: [],
    });

    await app.close();
  });

  it.each(['failed', 'skipped'] as const)('does not keep async_ai pending after async is %s', async (status) => {
    const app = Fastify();
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const crawlTargets = new InMemoryCrawlTargetRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    const now = new Date().toISOString();
    await sites.upsert({
      domain: `${status}-async.com`,
      updatedAt: now,
      meta: { title: `${status} async` },
    });
    await crawlTargets.update(`${status}-async.com`, {
      lastBrowserStatus: 'success',
      lastBrowserAt: now,
      lastAsyncStatus: status,
    });

    registerRoutes(app, {
      analyzeService: {} as AnalyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites,
      crawlTargets,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/sites/${status}-async.com`,
      headers: { 'x-api-key': 'test-api-key' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.enrichment.pending_layers).not.toContain('async_ai');
    expect(response.json().data.enrichment.pending_layers).toEqual(['traffic', 'whois']);

    await app.close();
  });

  it('returns computed legitimacy score and strips blocked crawl artifacts from site payloads', async () => {
    const app = Fastify();
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const crawlTargets = new InMemoryCrawlTargetRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    const now = new Date().toISOString();

    await sites.upsert({
      domain: 'blocked-site.com',
      updatedAt: now,
      meta: {
        title: 'Previously clean title',
        description: 'Previously clean description',
        techStackDetected: ['React'],
      },
      seo: {
        h1Count: 1,
        internalLinks: 12,
      },
      dns: {
        mxRecords: ['mx1.example.com'],
        nsRecords: ['ns1.example.com'],
      },
      taxonomy: {
        iabCategory: 'Technology & Computing',
        tags: ['saas'],
      },
      aiAnalysis: {
        risk: {
          sentiment: 'Professional',
          score: 5,
          isSpam: false,
        },
      },
      _meta: {
        html: {
          blocked: true,
          source: 'browser',
          length: 1400,
          primary_h1: 'Real heading',
        },
      },
    });

    registerRoutes(app, {
      analyzeService: {} as AnalyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites,
      crawlTargets,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/sites/blocked-site.com',
      headers: { 'x-api-key': 'test-api-key' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.report.meta).toBeUndefined();
    expect(response.json().data.report.seo).toBeUndefined();
    expect(response.json().data.report.taxonomy).toBeUndefined();
    expect(response.json().data.report.aiAnalysis).toBeUndefined();
    expect(response.json().data.report.score).toEqual(expect.objectContaining({
      value: expect.any(Number),
      signals: expect.any(Array),
    }));
    expect(response.json().data.report._meta.html).toMatchObject({
      blocked: true,
      length: 0,
    });
    expect(response.json().data.report.providerHealth).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'meta.provider', ok: false, errorCode: 'BOT_CHALLENGE_BLOCKED' }),
      expect.objectContaining({ provider: 'seo.provider', ok: false, errorCode: 'BOT_CHALLENGE_BLOCKED' }),
      expect.objectContaining({ provider: 'ai.provider', ok: false, errorCode: 'BOT_CHALLENGE_BLOCKED' }),
    ]));

    await app.close();
  });

  it('embeds the fresh report contract on ALREADY_FRESH analyze responses', async () => {
    const app = Fastify();
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const crawlTargets = new InMemoryCrawlTargetRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    const now = new Date().toISOString();
    await sites.upsert({
      domain: 'already-fresh.com',
      updatedAt: now,
      meta: { title: 'Already Fresh' },
    });
    await crawlTargets.update('already-fresh.com', {
      lastBrowserStatus: 'success',
      lastBrowserAt: now,
    });
    const analyzeService = {
      schedule: vi.fn().mockResolvedValue({
        accepted: true,
        reason: 'ALREADY_FRESH',
        jobId: null,
      }),
    } as unknown as AnalyzeService;

    registerRoutes(app, {
      analyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites,
      crawlTargets,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sites/analyze',
      headers: { 'x-api-key': 'test-api-key' },
      payload: { domain: 'already-fresh.com' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      ok: true,
      data: {
        job_id: null,
        status: 'completed',
        reason: 'ALREADY_FRESH',
        freshness: {
          is_stale: false,
          updated_at: now,
        },
        enrichment: {
          pending: true,
          pending_layers: ['async_ai', 'traffic', 'whois'],
        },
        report: {
          domain: 'already-fresh.com',
          meta: { title: 'Already Fresh' },
        },
      },
    });

    await app.close();
  });

  it('returns existing job id for duplicate analyze requests', async () => {
    const app = Fastify();
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    const analyzeService = {
      schedule: vi.fn().mockResolvedValue({
        accepted: false,
        reason: 'JOB_ALREADY_RUNNING',
        jobId: 'job-existing',
      }),
    } as unknown as AnalyzeService;

    registerRoutes(app, {
      analyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sites/analyze',
      headers: {
        'x-api-key': 'test-api-key',
      },
      payload: {
        domain: 'example.com',
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      ok: true,
      data: {
        job_id: 'job-existing',
        status: 'pending',
        priority: 'normal',
        reason: 'JOB_ALREADY_RUNNING',
      },
    });

    await app.close();
  });

  it('canonicalizes IDN analyze domains before scheduling', async () => {
    const app = Fastify();
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    const analyzeService = {
      schedule: vi.fn().mockResolvedValue({
        accepted: true,
        reason: 'ENQUEUED',
        jobId: 'job-idn',
      }),
    } as unknown as AnalyzeService;

    registerRoutes(app, {
      analyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sites/analyze',
      headers: {
        'x-api-key': 'test-api-key',
      },
      payload: {
        domain: 'Bücher.de',
      },
    });

    expect(response.statusCode).toBe(202);
    expect(analyzeService.schedule).toHaveBeenCalledWith('xn--bcher-kva.de', false, false, 'normal', false, undefined);

    await app.close();
  });

  it('returns 404 for missing alternatives target', async () => {
    const app = createAppWithAuth();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/sites/notfound.com/alternatives',
      headers: {
        'x-api-key': 'test-api-key',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('SITE_NOT_FOUND');

    await app.close();
  });

  it('accepts a previous api key during rotation', async () => {
    const app = Fastify();
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);

    registerRoutes(app, {
      analyzeService: {} as AnalyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites,
      queue,
    }, {
      apiKeys: ['new-key', 'old-key'],
      opsApiKeys: ['new-ops-key', 'old-ops-key'],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ops/dashboard?window=1h&recent_limit=10',
      headers: {
        'x-api-key': 'old-ops-key',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);

    await app.close();
  });

  it('rejects privileged analyze options for regular api keys', async () => {
    const app = Fastify();
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    const analyzeService = {
      schedule: vi.fn(),
    } as unknown as AnalyzeService;

    registerRoutes(app, {
      analyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sites/analyze',
      headers: {
        'x-api-key': 'test-api-key',
      },
      payload: {
        domain: 'example.com',
        force_refresh: true,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(analyzeService.schedule).not.toHaveBeenCalled();

    await app.close();
  });

  it('allows privileged analyze for the pro tier but denies /ops/* control', async () => {
    const app = Fastify();
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    const analyzeService = {
      schedule: vi.fn().mockResolvedValue({ accepted: true, reason: 'QUEUED', jobId: 'job-pro', priority: 'high' }),
    } as unknown as AnalyzeService;

    registerRoutes(app, {
      analyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
      proApiKeys: ['test-pro-key'],
    });

    // Pro key may submit a privileged (priority:'high') analyze, and is tagged as the 'pro' rate-limit tier.
    const analyzeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/sites/analyze',
      headers: { 'x-api-key': 'test-pro-key' },
      payload: { domain: 'example.com', priority: 'high' },
    });
    expect(analyzeRes.statusCode).toBe(202);
    expect(analyzeRes.headers['x-sitejson-ratelimit-tier']).toBe('pro');
    expect(analyzeService.schedule).toHaveBeenCalled();

    // Pro key is denied the /ops/* control endpoints (ops-only).
    const opsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/ops/dashboard?window=1h&recent_limit=10',
      headers: { 'x-api-key': 'test-pro-key' },
    });
    expect(opsRes.statusCode).toBe(403);

    await app.close();
  });

  it('returns 503 when the analyze queue is saturated', async () => {
    const app = Fastify();
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    const analyzeService = {
      schedule: vi.fn().mockRejectedValue(new QueueCapacityError("OOM command not allowed when used memory > 'maxmemory'.")),
    } as unknown as AnalyzeService;

    registerRoutes(app, {
      analyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sites/analyze',
      headers: { 'x-api-key': 'test-api-key' },
      payload: { domain: 'example.com' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('QUEUE_OVERLOADED');

    await app.close();
  });

  it('uses separate analyze rate-limit tiers for public and ops keys', async () => {
    const app = Fastify();
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    const analyzeService = {
      schedule: vi.fn().mockResolvedValue({ jobId: 'job-1', reason: undefined }),
    } as unknown as AnalyzeService;

    registerRoutes(app, {
      analyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
      analyzeRateLimits: {
        public: 1,
        ops: 2,
      },
    });

    const publicFirst = await app.inject({
      method: 'POST',
      url: '/api/v1/sites/analyze',
      headers: {
        'x-api-key': 'test-api-key',
      },
      payload: { domain: 'example.com' },
    });
    const publicSecond = await app.inject({
      method: 'POST',
      url: '/api/v1/sites/analyze',
      headers: {
        'x-api-key': 'test-api-key',
      },
      payload: { domain: 'example.com' },
    });
    const opsFirst = await app.inject({
      method: 'POST',
      url: '/api/v1/sites/analyze',
      headers: {
        'x-api-key': 'test-ops-key',
      },
      payload: { domain: 'example.com' },
    });
    const opsSecond = await app.inject({
      method: 'POST',
      url: '/api/v1/sites/analyze',
      headers: {
        'x-api-key': 'test-ops-key',
      },
      payload: { domain: 'example.com' },
    });
    const opsThird = await app.inject({
      method: 'POST',
      url: '/api/v1/sites/analyze',
      headers: {
        'x-api-key': 'test-ops-key',
      },
      payload: { domain: 'example.com' },
    });

    expect(publicFirst.statusCode).toBe(202);
    expect(publicFirst.headers['x-ratelimit-limit']).toBe('1');
    expect(publicFirst.headers['x-sitejson-ratelimit-tier']).toBe('public');
    expect(publicSecond.statusCode).toBe(429);
    expect(publicSecond.json().error.code).toBe('RATE_LIMITED');

    expect(opsFirst.statusCode).toBe(202);
    expect(opsFirst.headers['x-ratelimit-limit']).toBe('2');
    expect(opsFirst.headers['x-sitejson-ratelimit-tier']).toBe('ops');
    expect(opsSecond.statusCode).toBe(202);
    expect(opsThird.statusCode).toBe(429);

    await app.close();
  });

  it('uses trusted BFF client fingerprints as independent analyze buckets', async () => {
    const app = Fastify();
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    const analyzeService = {
      schedule: vi.fn().mockResolvedValue({ jobId: 'job-1', reason: 'QUEUED' }),
    } as unknown as AnalyzeService;

    registerRoutes(app, {
      analyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
      analyzeRateLimits: {
        public: 10,
        ops: 10,
      },
      analyzeClientRateLimits: {
        public: 1,
        ops: 10,
      },
    });

    const firstClientA = await app.inject({
      method: 'POST',
      url: '/api/v1/sites/analyze',
      headers: {
        'x-api-key': 'test-api-key',
        'x-sitejson-client': 'aaaaaaaaaaaaaaaa',
      },
      payload: { domain: 'example.com' },
    });
    const secondClientA = await app.inject({
      method: 'POST',
      url: '/api/v1/sites/analyze',
      headers: {
        'x-api-key': 'test-api-key',
        'x-sitejson-client': 'aaaaaaaaaaaaaaaa',
      },
      payload: { domain: 'example.org' },
    });
    const firstClientB = await app.inject({
      method: 'POST',
      url: '/api/v1/sites/analyze',
      headers: {
        'x-api-key': 'test-api-key',
        'x-sitejson-client': 'bbbbbbbbbbbbbbbb',
      },
      payload: { domain: 'example.net' },
    });

    expect(firstClientA.statusCode).toBe(202);
    expect(firstClientA.headers['x-ratelimit-limit']).toBe('1');
    expect(secondClientA.statusCode).toBe(429);
    expect(secondClientA.headers['retry-after']).toBeDefined();
    expect(secondClientA.json().error.code).toBe('RATE_LIMITED');
    expect(firstClientB.statusCode).toBe(202);
    expect(firstClientB.headers['x-ratelimit-limit']).toBe('1');

    await app.close();
  });

  it('keeps the aggregate analyze key bucket active across trusted BFF clients', async () => {
    const app = Fastify();
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    const analyzeService = {
      schedule: vi.fn().mockResolvedValue({ jobId: 'job-1', reason: 'QUEUED' }),
    } as unknown as AnalyzeService;

    registerRoutes(app, {
      analyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
      analyzeRateLimits: {
        public: 2,
        ops: 10,
      },
      analyzeClientRateLimits: {
        public: 5,
        ops: 10,
      },
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/sites/analyze',
      headers: {
        'x-api-key': 'test-api-key',
        'x-sitejson-client': '1111111111111111',
      },
      payload: { domain: 'example.com' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/sites/analyze',
      headers: {
        'x-api-key': 'test-api-key',
        'x-sitejson-client': '2222222222222222',
      },
      payload: { domain: 'example.org' },
    });
    const third = await app.inject({
      method: 'POST',
      url: '/api/v1/sites/analyze',
      headers: {
        'x-api-key': 'test-api-key',
        'x-sitejson-client': '3333333333333333',
      },
      payload: { domain: 'example.net' },
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(third.statusCode).toBe(429);
    expect(third.headers['x-ratelimit-limit']).toBe('5');
    expect(third.headers['x-sitejson-ratelimit-tier']).toBe('public');
    expect(third.headers['retry-after']).toBeDefined();

    await app.close();
  });

  it('ignores invalid BFF client fingerprints and falls back to the existing analyze key bucket', async () => {
    const app = Fastify();
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    const analyzeService = {
      schedule: vi.fn().mockResolvedValue({ jobId: 'job-1', reason: 'QUEUED' }),
    } as unknown as AnalyzeService;

    registerRoutes(app, {
      analyzeService,
      ingestService: {} as IngestService,
      opsDashboardService,
      jobs,
      sites,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
      analyzeRateLimits: {
        public: 1,
        ops: 10,
      },
      analyzeClientRateLimits: {
        public: 10,
        ops: 10,
      },
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/sites/analyze',
      headers: {
        'x-api-key': 'test-api-key',
        'x-sitejson-client': 'not-a-fingerprint',
      },
      payload: { domain: 'example.com' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/sites/analyze',
      headers: {
        'x-api-key': 'test-api-key',
        'x-sitejson-client': 'not-a-fingerprint',
      },
      payload: { domain: 'example.org' },
    });

    expect(first.statusCode).toBe(202);
    expect(first.headers['x-ratelimit-limit']).toBe('1');
    expect(second.statusCode).toBe(429);
    expect(second.headers['x-ratelimit-limit']).toBe('1');

    await app.close();
  });

  it('rate-limits ingest separately from analyze using the configured key tier', async () => {
    const app = Fastify();
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    const ingestService = {
      enqueueBatch: vi.fn().mockResolvedValue({
        accepted: ['example.com'],
        skipped: [],
        invalid: [],
      }),
    } as unknown as IngestService;

    registerRoutes(app, {
      analyzeService: {} as AnalyzeService,
      ingestService,
      opsDashboardService,
      jobs,
      sites,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
      analyzeRateLimits: {
        public: 5,
        ops: 5,
      },
      ingestRateLimits: {
        public: 1,
        ops: 2,
      },
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/domains',
      headers: {
        'x-api-key': 'test-api-key',
      },
      payload: { domains: ['example.com'] },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/domains',
      headers: {
        'x-api-key': 'test-api-key',
      },
      payload: { domains: ['example.org'] },
    });

    expect(first.statusCode).toBe(202);
    expect(first.headers['x-ratelimit-limit']).toBe('1');
    expect(first.headers['x-sitejson-ratelimit-tier']).toBe('public');
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('RATE_LIMITED');

    await app.close();
  });

  it('returns 503 when the ingest queue is saturated', async () => {
    const app = Fastify();
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const queue = new InMemoryJobQueue();
    const opsDashboardService = new OpsDashboardService(jobs, queue);
    const ingestService = {
      enqueueBatch: vi.fn().mockRejectedValue(new QueueCapacityError("OOM command not allowed when used memory > 'maxmemory'.")),
    } as unknown as IngestService;

    registerRoutes(app, {
      analyzeService: {} as AnalyzeService,
      ingestService,
      opsDashboardService,
      jobs,
      sites,
      queue,
    }, {
      apiKeys: ['test-api-key'],
      opsApiKeys: ['test-ops-key'],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/domains',
      headers: { 'x-api-key': 'test-api-key' },
      payload: { domains: ['example.com'] },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('QUEUE_OVERLOADED');

    await app.close();
  });

  it('rejects invalid alternatives query', async () => {
    const app = createAppWithAuth();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/sites/example.com/alternatives?limit=200',
      headers: {
        'x-api-key': 'test-api-key',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');

    await app.close();
  });
});
