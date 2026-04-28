import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerRoutes } from '../routes.js';
import type { AnalyzeService } from '../../services/analyze-service.js';
import type { IngestService } from '../../services/ingest-service.js';
import { OpsDashboardService } from '../../services/ops-dashboard-service.js';
import { InMemoryJobRepository, InMemorySiteRepository } from '../../storage/in-memory.js';
import { InMemoryJobQueue } from '../../queue/in-memory.js';

const createAppWithAuth = () => {
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
    apiKeys: ['test-api-key'],
  });

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

  it('allows dashboard route with api key', async () => {
    const app = createAppWithAuth();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ops/dashboard?window=1h&recent_limit=10',
      headers: {
        'x-api-key': 'test-api-key',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
    expect(response.json().data.window).toBe('1h');

    await app.close();
  });

  it('allows public docs routes without api key', async () => {
    const app = createAppWithAuth();

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

  it('rejects invalid dashboard query', async () => {
    const app = createAppWithAuth();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ops/dashboard?window=24h',
      headers: {
        'x-api-key': 'test-api-key',
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
    expect(payload.data.algorithm).toBe('rule_based');
    expect(payload.data.items.length).toBe(2);
    expect(payload.data.items[0].domain).not.toBe('target.com');

    await isolatedApp.close();
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
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ops/dashboard?window=1h&recent_limit=10',
      headers: {
        'x-api-key': 'old-key',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);

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
