import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueCapacityError } from '../../queue/errors.js';

vi.mock('../schemas.js', () => ({
  analyzeRequestSchema: { safeParse: (body: unknown) => ({ success: true, data: body }) },
  alternativesQuerySchema: { safeParse: (query: unknown) => ({ success: true, data: query }) },
  directoryParamsSchema: { safeParse: (params: unknown) => ({ success: true, data: params }) },
  ingestDomainsSchema: { safeParse: (body: unknown) => ({ success: true, data: body }) },
  opsDashboardQuerySchema: { safeParse: (query: unknown) => ({ success: true, data: query }) },
  retryDlqSchema: { safeParse: (body: unknown) => ({ success: true, data: body }) },
  trafficHistoryQuerySchema: { safeParse: (query: unknown) => ({ success: true, data: query }) },
}));

vi.mock('../../services/domain.js', () => ({
  normalizeDomain: (input: string) => input.toLowerCase(),
}));

const { buildSiteReportResponse } = vi.hoisted(() => ({
  buildSiteReportResponse: vi.fn(async (_deps, report) => ({
    sanitizedReport: report,
    data: {
      domain: report.domain,
      status: 'completed',
      freshness: {
        is_stale: false,
        updated_at: report.updatedAt,
      },
      enrichment: {
        pending: false,
        pending_layers: [],
      },
      report,
    },
  })),
}));

vi.mock('../../services/site-report-response.js', () => ({
  buildSiteReportResponse,
}));

import { registerRoutes } from '../routes.js';

type RouteHandler = (request: any, reply: any) => Promise<unknown> | unknown;

const createFakeApp = () => {
  const routes = new Map<string, RouteHandler>();
  return {
    routes,
    addHook: vi.fn(),
    post(path: string, handler: RouteHandler) {
      routes.set(`POST ${path}`, handler);
    },
    get(path: string, handler: RouteHandler) {
      routes.set(`GET ${path}`, handler);
    },
  };
};

const createReply = () => {
  const reply = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    header(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      return payload;
    },
  };
  return reply;
};

const createBaseDeps = () => ({
  analyzeService: {} as any,
  ingestService: {} as any,
  opsDashboardService: {
    getDashboard: vi.fn(),
  } as any,
  jobs: {
    getById: vi.fn(),
    healthCheck: vi.fn(async () => true),
  } as any,
  sites: {
    getByDomain: vi.fn(),
    healthCheck: vi.fn(async () => true),
    searchDirectory: vi.fn(),
    getDirectoryStats: vi.fn(),
    getDirectoryTypeSummary: vi.fn(),
    getGlobalInsights: vi.fn(),
    findAlternatives: vi.fn(),
  } as any,
  crawlTargets: {
    getByDomain: vi.fn(),
  } as any,
  queue: {
    getAllCounts: vi.fn(),
    retryFailed: vi.fn(),
    healthCheck: vi.fn(async () => true),
  } as any,
  trafficHistoryService: {
    isConfigured: vi.fn(() => true),
    getHistory: vi.fn(),
  } as any,
});

describe('registerRoutes handler behavior without Fastify runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 503 when analyze scheduling hits queue capacity', async () => {
    const app = createFakeApp();
    const deps = createBaseDeps();
    deps.analyzeService = {
      schedule: vi.fn().mockRejectedValue(new QueueCapacityError("OOM command not allowed when used memory > 'maxmemory'.")),
    };
    registerRoutes(app as any, deps as any, {});

    const handler = app.routes.get('POST /api/v1/sites/analyze');
    const reply = createReply();
    await handler?.({
      id: 'trc-1',
      body: { domain: 'example.com' },
      headers: {},
      ip: '127.0.0.1',
    }, reply);

    expect(reply.statusCode).toBe(503);
    expect((reply.payload as any).error.code).toBe('QUEUE_OVERLOADED');
  });

  it('returns 503 when ingest scheduling hits queue capacity', async () => {
    const app = createFakeApp();
    const deps = createBaseDeps();
    deps.ingestService = {
      enqueueBatch: vi.fn().mockRejectedValue(new QueueCapacityError("OOM command not allowed when used memory > 'maxmemory'.")),
    };
    registerRoutes(app as any, deps as any, {});

    const handler = app.routes.get('POST /api/v1/ingest/domains');
    const reply = createReply();
    await handler?.({
      id: 'trc-2',
      body: { domains: ['example.com'] },
      headers: {},
      ip: '127.0.0.1',
    }, reply);

    expect(reply.statusCode).toBe(503);
    expect((reply.payload as any).error.code).toBe('QUEUE_OVERLOADED');
  });

  it('starts crawl target fetch in parallel for ALREADY_FRESH analyze responses', async () => {
    const app = createFakeApp();
    const deps = createBaseDeps();
    let resolveReport!: (value: unknown) => void;
    const reportPromise = new Promise((resolve) => {
      resolveReport = resolve;
    });
    deps.analyzeService = {
      schedule: vi.fn().mockResolvedValue({ accepted: true, reason: 'ALREADY_FRESH', jobId: null }),
    };
    deps.sites.getByDomain.mockReturnValue(reportPromise);
    deps.crawlTargets.getByDomain.mockResolvedValue({ domain: 'example.com' });
    registerRoutes(app as any, deps as any, {});

    const handler = app.routes.get('POST /api/v1/sites/analyze');
    const reply = createReply();
    const pending = handler?.({
      id: 'trc-3',
      body: { domain: 'example.com' },
      headers: {},
      ip: '127.0.0.1',
    }, reply);

    await Promise.resolve();
    expect(deps.crawlTargets.getByDomain).toHaveBeenCalledWith('example.com');

    resolveReport({
      domain: 'example.com',
      updatedAt: '2026-07-04T00:00:00.000Z',
    });
    await pending;

    expect(buildSiteReportResponse).toHaveBeenCalledWith(
      { crawlTarget: { domain: 'example.com' } },
      expect.objectContaining({ domain: 'example.com' }),
    );
  });

  it('starts crawl target fetch in parallel for /sites/:domain responses', async () => {
    const app = createFakeApp();
    const deps = createBaseDeps();
    let resolveReport!: (value: unknown) => void;
    const reportPromise = new Promise((resolve) => {
      resolveReport = resolve;
    });
    deps.sites.getByDomain.mockReturnValue(reportPromise);
    deps.crawlTargets.getByDomain.mockResolvedValue({ domain: 'example.com' });
    registerRoutes(app as any, deps as any, {});

    const handler = app.routes.get('GET /api/v1/sites/:domain');
    const reply = createReply();
    const pending = handler?.({
      id: 'trc-4',
      params: { domain: 'example.com' },
      query: {},
      headers: {},
    }, reply);

    await Promise.resolve();
    expect(deps.crawlTargets.getByDomain).toHaveBeenCalledWith('example.com');

    resolveReport({
      domain: 'example.com',
      updatedAt: '2026-07-04T00:00:00.000Z',
    });
    await pending;

    expect(buildSiteReportResponse).toHaveBeenCalledWith(
      { crawlTarget: { domain: 'example.com' } },
      expect.objectContaining({ domain: 'example.com' }),
    );
  });
});
