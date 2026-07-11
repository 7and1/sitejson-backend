import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path, { resolve } from 'node:path';
import type { Pool } from 'pg';
import { createLogger } from './observability/logger.js';
import { loadEnv } from './config/env.js';
import { registerRoutes } from './api/routes.js';
import { InMemoryJobQueue } from './queue/in-memory.js';
import { BullMqJobQueue, parseRedisUrl } from './queue/bullmq.js';
import { Redis } from 'ioredis';
import type { RedisLike } from './storage/swr-cache.js';
import {
  InMemoryCrawlTargetRepository,
  InMemoryJobRepository,
  InMemoryRadarSnapshotRepository,
  InMemorySiteRepository,
} from './storage/in-memory.js';
import {
  createPostgresPool,
  PostgresCrawlTargetRepository,
  ensurePostgresSchema,
  PostgresJobRepository,
  PostgresRadarSnapshotRepository,
  PostgresSiteRepository,
} from './storage/postgres.js';
import { AnalyzeService } from './services/analyze-service.js';
import { IngestService } from './services/ingest-service.js';
import { OpsDashboardService } from './services/ops-dashboard-service.js';
import { Orchestrator, deriveHistoryTimeoutMs } from './core/orchestrator.js';
import { TrafficHistoryService } from './services/traffic-history-service.js';
import {
  AdsProvider,
  AhrefsDomainRatingProvider,
  AiProvider,
  ArchiveHistoryProvider,
  DnsProvider,
  FilesProvider,
  MetaProvider,
  PublisherProvider,
  RadarProvider,
  SeoProvider,
  TrafficProvider,
  VisualProvider,
  WhoisProvider,
} from './providers/index.js';
import type { Provider } from './providers/index.js';
import type { JobQueue } from './queue/interfaces.js';
import type { CrawlTargetRepository, JobRepository, RadarSnapshotRepository, SiteRepository } from './storage/interfaces.js';
import { ScreenshotStorage } from './lib/screenshot-storage.js';
import { RadarSyncService } from './services/radar-sync-service.js';
import { buildOpenApiSpec } from './api/openapi.js';

export interface AppDependencies {
  queue: JobQueue;
  jobs: JobRepository;
  sites: SiteRepository;
  radarSnapshots: RadarSnapshotRepository;
  crawlTargets: CrawlTargetRepository;
}

export interface AppRuntime {
  app: ReturnType<typeof Fastify>;
  env: ReturnType<typeof loadEnv>;
  dependencies: AppDependencies;
  orchestrator: Orchestrator;
  logger: ReturnType<typeof createLogger>;
  freshnessTtlSec: number;
  close: () => Promise<void>;
}

type RuntimeRole = 'api' | 'worker';

const buildProviderOptions = (env: ReturnType<typeof loadEnv>) => ({
  timeoutMs: env.PROVIDER_TIMEOUT_MS,
  retryAttempts: env.PROVIDER_RETRY_ATTEMPTS,
  retryBaseMs: env.PROVIDER_RETRY_BASE_MS,
});

export const resolvePgPoolMax = (
  env: ReturnType<typeof loadEnv>,
  role: RuntimeRole,
  rawEnv: NodeJS.ProcessEnv = process.env,
): number => {
  if (role === 'worker') {
    if (typeof rawEnv.PG_POOL_MAX_WORKER === 'string' && rawEnv.PG_POOL_MAX_WORKER.trim().length > 0) {
      return env.PG_POOL_MAX_WORKER ?? env.PG_POOL_MAX;
    }
    if (typeof rawEnv.PG_POOL_MAX === 'string' && rawEnv.PG_POOL_MAX.trim().length > 0) {
      return env.PG_POOL_MAX;
    }
    return 50;
  }

  if (typeof rawEnv.PG_POOL_MAX_API === 'string' && rawEnv.PG_POOL_MAX_API.trim().length > 0) {
    return env.PG_POOL_MAX_API ?? env.PG_POOL_MAX;
  }
  if (typeof rawEnv.PG_POOL_MAX === 'string' && rawEnv.PG_POOL_MAX.trim().length > 0) {
    return env.PG_POOL_MAX;
  }
  return 20;
};

const parseProxyListFile = (filePath: string): string | undefined => {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    return undefined;
  }

  const content = readFileSync(resolved, 'utf8');
  const entries = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => (
      line.length > 0
      && !line.startsWith('#')
      && !line.startsWith('##')
      && !line.toLowerCase().startsWith('usage:')
    ));

  if (entries.length === 0) {
    return undefined;
  }

  return entries.join('|');
};

const resolveProxyList = (input: {
  inlineValue?: string;
  filePath?: string;
  logger: ReturnType<typeof createLogger>;
  label: 'primary' | 'fallback';
}): string | undefined => {
  const inline = input.inlineValue?.trim();
  if (inline) {
    return inline;
  }

  if (!input.filePath) {
    return undefined;
  }

  const fromFile = parseProxyListFile(input.filePath);
  if (fromFile) {
    input.logger.info({
      module: 'app',
      event: 'proxy_list_loaded_from_file',
      label: input.label,
      filePath: input.filePath,
      count: fromFile.split('|').length,
    });
    return fromFile;
  }

  input.logger.warn({
    module: 'app',
    event: 'proxy_list_file_missing_or_empty',
    label: input.label,
    filePath: input.filePath,
  });
  return undefined;
};

const parseCorsAllowlist = (raw: string): string[] => (
  raw.split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);

const resolveAllowedOrigin = (requestOrigin: string | undefined, allowlist: string[]): string | null => {
  if (allowlist.includes('*')) {
    return '*';
  }

  if (!requestOrigin) {
    return allowlist[0] ?? null;
  }

  return allowlist.includes(requestOrigin) ? requestOrigin : null;
};

const applyCorsHeaders = (
  requestOrigin: string | undefined,
  reply: { header: (name: string, value: string) => void },
  allowlist: string[],
) => {
  const allowedOrigin = resolveAllowedOrigin(requestOrigin, allowlist);
  if (allowedOrigin) {
    reply.header('access-control-allow-origin', allowedOrigin);
  }
  reply.header('vary', 'Origin');
  reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
  reply.header('access-control-allow-headers', 'authorization,content-type,x-api-key');
};

export const buildApp = async (
  provided?: Partial<AppDependencies>,
  options?: { runtimeRole?: RuntimeRole },
): Promise<AppRuntime> => {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const app = Fastify({ logger: false, trustProxy: true });
  const corsAllowlist = parseCorsAllowlist(env.CORS_ALLOWLIST);
  const runtimeRole = options?.runtimeRole ?? 'api';

  app.setErrorHandler((error, request, reply) => {
    const errorRecord = error instanceof Error
      ? error as Error & { statusCode?: number }
      : { message: String(error), stack: undefined, statusCode: undefined };
    const statusCode = typeof errorRecord.statusCode === 'number' && errorRecord.statusCode >= 400 && errorRecord.statusCode < 600
      ? errorRecord.statusCode
      : 500;

    logger.error({
      trace_id: request.id,
      module: 'app',
      event: 'request_error',
      status_code: statusCode,
      error: errorRecord.message,
      stack: env.NODE_ENV === 'production' ? undefined : errorRecord.stack,
    });

    const isServerError = statusCode >= 500;
    return reply.status(statusCode).send({
      ok: false,
      error: {
        code: isServerError ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
        message: env.NODE_ENV === 'production' && isServerError ? 'Unexpected server error' : errorRecord.message,
      },
      meta: {
        trace_id: request.id,
      },
    });
  });

  const exposeApiDocs = env.NODE_ENV !== 'production';
  if (exposeApiDocs) {
    await app.register(swagger as any, {
      openapi: buildOpenApiSpec() as any,
    });

    await app.register(swaggerUi as any, {
      routePrefix: '/api/docs',
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
      },
    });

    app.get('/api/openapi.json', async () => buildOpenApiSpec());
  }

  if (env.SCREENSHOT_STORAGE === 'local') {
    const screenshotRoot = path.resolve(env.SCREENSHOT_LOCAL_DIR);
    await mkdir(screenshotRoot, { recursive: true });
    await app.register(fastifyStatic, {
      root: screenshotRoot,
      prefix: '/snapshots/',
      decorateReply: false,
      cacheControl: true,
      maxAge: '7d',
    });
  }

  let pgPool: Pool | null = null;
  let cacheRedis: Redis | null = null;

  app.addHook('onRequest', async (request, reply) => {
    applyCorsHeaders(request.headers.origin, reply, corsAllowlist);
  });

  app.options('/*', async (request, reply) => {
    applyCorsHeaders(request.headers.origin, reply, corsAllowlist);
    return reply.status(204).send();
  });

  const buildStorageDependencies = async (): Promise<{
    sites: SiteRepository;
    jobs: JobRepository;
    radarSnapshots: RadarSnapshotRepository;
    crawlTargets: CrawlTargetRepository;
  }> => {
    if (provided?.sites && provided?.jobs && provided?.radarSnapshots && provided?.crawlTargets) {
      return {
        sites: provided.sites,
        jobs: provided.jobs,
        radarSnapshots: provided.radarSnapshots,
        crawlTargets: provided.crawlTargets,
      };
    }

    if (env.STORAGE_DRIVER === 'postgres') {
      if (!env.DATABASE_URL) {
        throw new Error(
          'DATABASE_URL is required when STORAGE_DRIVER=postgres',
        );
      }
      pgPool = createPostgresPool(env.DATABASE_URL, {
        max: resolvePgPoolMax(env, runtimeRole),
        statementTimeoutMs: env.PG_STATEMENT_TIMEOUT_MS,
        applicationName: env.SITEJSON_SERVICE_NAME,
        logger,
      });
      await ensurePostgresSchema(pgPool);

      if (env.REDIS_URL) {
        const conn = parseRedisUrl(env.REDIS_URL, env.REDIS_PASSWORD);
        cacheRedis = new Redis({
          host: conn.host,
          port: conn.port,
          username: conn.username,
          password: conn.password,
          tls: conn.tls,
          maxRetriesPerRequest: null,
        });
        cacheRedis.on('error', (error: unknown) => logger.warn({ module: 'cache', event: 'redis_error', error: String(error) }));
      }

      return {
        sites: provided?.sites ?? new PostgresSiteRepository(
          pgPool,
          cacheRedis ? { cacheRedis: cacheRedis as unknown as RedisLike } : undefined,
        ),
        jobs: provided?.jobs ?? new PostgresJobRepository(pgPool),
        radarSnapshots: provided?.radarSnapshots ?? new PostgresRadarSnapshotRepository(pgPool),
        crawlTargets: provided?.crawlTargets ?? new PostgresCrawlTargetRepository(pgPool),
      };
    }

    return {
      sites: provided?.sites ?? new InMemorySiteRepository(),
      jobs: provided?.jobs ?? new InMemoryJobRepository(),
      radarSnapshots: provided?.radarSnapshots ?? new InMemoryRadarSnapshotRepository(),
      crawlTargets: provided?.crawlTargets ?? new InMemoryCrawlTargetRepository(),
    };
  };

  const buildQueueDependency = (): JobQueue => {
    if (provided?.queue) {
      return provided.queue;
    }

    if (env.QUEUE_DRIVER === 'bullmq') {
      if (!env.REDIS_URL) {
        throw new Error('REDIS_URL is required when QUEUE_DRIVER=bullmq');
      }
      return new BullMqJobQueue(
        parseRedisUrl(env.REDIS_URL, env.REDIS_PASSWORD),
        env.QUEUE_NAME,
        {
          ingest: env.QUEUE_CONCURRENCY_INGEST,
          browser_realtime: env.QUEUE_CONCURRENCY_BROWSER_REALTIME,
          browser: env.QUEUE_CONCURRENCY_BROWSER,
          async: env.QUEUE_CONCURRENCY_ASYNC,
          radar: env.QUEUE_CONCURRENCY_RADAR,
          traffic: env.QUEUE_CONCURRENCY_TRAFFIC,
          whois: env.QUEUE_CONCURRENCY_WHOIS,
        },
        env.QUEUE_CONCURRENCY,
      );
    }

    return new InMemoryJobQueue();
  };

  const storageDependencies = await buildStorageDependencies();
  const sites = storageDependencies.sites;
  const jobs = storageDependencies.jobs;
  const radarSnapshots = storageDependencies.radarSnapshots;
  const crawlTargets = storageDependencies.crawlTargets;
  const queue = buildQueueDependency();

  const providerOptions = buildProviderOptions(env);
  const trafficProxyList = resolveProxyList({
    inlineValue: env.PROXY_LIST,
    filePath: env.PROXY_LIST_FILE,
    logger,
    label: 'primary',
  });
  const trafficFallbackProxyList = resolveProxyList({
    inlineValue: env.PROXY_LIST_FALLBACK,
    filePath: env.PROXY_LIST_FALLBACK_FILE,
    logger,
    label: 'fallback',
  });
  const screenshotStorage = new ScreenshotStorage({
    mode: env.SCREENSHOT_STORAGE,
    localDir: env.SCREENSHOT_LOCAL_DIR,
    publicBaseUrl: env.SCREENSHOT_PUBLIC_BASE_URL,
  });
  const radarSyncService = new RadarSyncService(queue, logger);
  const trafficHistoryService = new TrafficHistoryService({
    enabled: env.TRAFFIC_SIMILARWEB_ENABLED,
    baseUrl: env.TRAFFIC_SIMILARWEB_BASE_URL,
    apiKey: env.TRAFFIC_SIMILARWEB_API_KEY,
    timeoutMs: env.TRAFFIC_SIMILARWEB_TIMEOUT_MS,
    retryAttempts: env.PROVIDER_RETRY_ATTEMPTS,
    retryBaseMs: env.PROVIDER_RETRY_BASE_MS,
  });
  const providers: Provider[] = [
    new VisualProvider(
      screenshotStorage,
      logger,
      env.PROXY_GRID_BASE_URL && env.PROXY_GRID_SECRET ? {
        baseUrl: env.PROXY_GRID_BASE_URL,
        secret: env.PROXY_GRID_SECRET,
      } : undefined,
      env.SOAX_API_SECRET ? {
        apiUrl: env.SOAX_API_URL,
        secret: env.SOAX_API_SECRET,
        country: env.SOAX_PROXY_COUNTRY,
        proxyType: env.SOAX_PROXY_TYPE,
      } : undefined,
    ),
    new MetaProvider(providerOptions, env.USER_AGENT),
    new SeoProvider(providerOptions, env.USER_AGENT),
    new DnsProvider(providerOptions),
    new AdsProvider(
      providerOptions,
      env.USER_AGENT,
      2840,
      trafficProxyList,
      trafficFallbackProxyList,
      env.TRAFFIC_ROTATION_MAX_PRIMARY_PROXIES,
    ),
    new PublisherProvider(providerOptions, env.USER_AGENT),
    new FilesProvider(providerOptions, env.USER_AGENT),
    ...(env.AHREFS_DR_ENABLED ? [
      new AhrefsDomainRatingProvider(
        providerOptions,
        env.USER_AGENT,
        env.AHREFS_DR_ENDPOINT,
      ),
    ] : []),
    ...(env.ARCHIVE_HISTORY_ENABLED ? [
      new ArchiveHistoryProvider(
        {
          enabled: env.ARCHIVE_HISTORY_ENABLED,
          baseUrl: env.ARCHIVE_HISTORY_BASE_URL,
          apiKey: env.ARCHIVE_HISTORY_API_KEY,
          computeOnMiss: env.ARCHIVE_HISTORY_COMPUTE_ON_MISS,
          maxTitles: env.ARCHIVE_HISTORY_MAX_TITLES,
          timeoutMs: env.ARCHIVE_HISTORY_TIMEOUT_MS,
        },
        providerOptions,
      ),
    ] : []),
    new TrafficProvider(
      providerOptions,
      trafficProxyList,
      trafficFallbackProxyList,
      env.TRAFFIC_FALLBACK_CHAIN_ENABLED
        ? {
            flareSolverr: {
              baseUrl: env.FLARESOLVERR_BASE_URL,
              timeoutMs: env.FLARESOLVERR_TIMEOUT_MS,
              retryAttempts: env.PROVIDER_RETRY_ATTEMPTS,
              retryBaseMs: env.PROVIDER_RETRY_BASE_MS,
              maxTimeoutMs: env.FLARESOLVERR_MAX_TIMEOUT_MS,
              session: env.FLARESOLVERR_SESSION,
            },
            proxyGrid: {
              baseUrl: env.PROXY_GRID_BASE_URL,
              secret: env.PROXY_GRID_SECRET,
              timeoutMs: env.PROVIDER_TIMEOUT_MS,
              retryAttempts: env.PROVIDER_RETRY_ATTEMPTS,
              retryBaseMs: env.PROVIDER_RETRY_BASE_MS,
            },
            soax: {
              apiUrl: env.SOAX_API_URL,
              secret: env.SOAX_API_SECRET,
              timeoutMs: env.PROVIDER_TIMEOUT_MS,
              retryAttempts: env.PROVIDER_RETRY_ATTEMPTS,
              retryBaseMs: env.PROVIDER_RETRY_BASE_MS,
              country: env.SOAX_PROXY_COUNTRY,
              proxyType: env.SOAX_PROXY_TYPE,
            },
          }
        : undefined,
      {
        enabled: env.TRAFFIC_SIMILARWEB_ENABLED,
        baseUrl: env.TRAFFIC_SIMILARWEB_BASE_URL,
        apiKey: env.TRAFFIC_SIMILARWEB_API_KEY,
        maxAgeDays: env.TRAFFIC_SIMILARWEB_MAX_AGE_DAYS,
        timeoutMs: env.TRAFFIC_SIMILARWEB_TIMEOUT_MS,
      },
      {
        maxPrimaryProxies: env.TRAFFIC_ROTATION_MAX_PRIMARY_PROXIES,
      },
    ),
    new WhoisProvider(providerOptions, env.USER_AGENT),
    new RadarProvider(radarSnapshots, radarSyncService, env.RADAR_TTL_SEC),
    new AiProvider(
      {
        timeoutMs: env.AI_TIMEOUT_MS,
        retryAttempts: env.PROVIDER_RETRY_ATTEMPTS,
        retryBaseMs: env.PROVIDER_RETRY_BASE_MS,
      },
      env.GEMINI_API_KEY,
      env.GEMINI_MODEL,
      env.MOONSHOT_API_KEY,
      env.AI_BASE_URL,
      env.AI_MODEL,
      logger,
      env.BIGMODEL_API_KEY,
      env.BIGMODEL_BASE_URL,
      env.BIGMODEL_MODEL,
      env.CODEX_API_KEY,
      env.CODEX_BASE_URL,
      env.CODEX_MODEL,
      env.AI_VISION_ENABLED,
      env.AI_VISION_RANK_LIMIT,
      env.CODEX_WIRE_API,
    ),
  ];

  const orchestrator = new Orchestrator(
    providers,
    logger,
    {
      timeoutMs: env.PROVIDER_TIMEOUT_MS,
      providerQuickTimeoutMs: env.PROVIDER_TIMEOUT_MS_FAST,
      aiTimeoutMs: env.AI_TIMEOUT_MS,
      historyTimeoutMs: deriveHistoryTimeoutMs(env.ARCHIVE_HISTORY_TIMEOUT_MS),
      retryAttempts: env.PROVIDER_RETRY_ATTEMPTS,
      retryBaseMs: env.PROVIDER_RETRY_BASE_MS,
      userAgent: env.USER_AGENT,
      aiEnableAutoTrigger: env.AI_ENABLE_AUTO_TRIGGER,
      aiAutoTriggerRankLimit: env.AI_AUTO_TRIGGER_RANK_LIMIT,
      browserEnabled: env.BROWSER_ENABLED,
      browserTimeoutMs: env.BROWSER_TIMEOUT_MS,
      browserHighValueTimeoutMs: env.BROWSER_TIMEOUT_MS_HIGH_VALUE,
      browserNetworkIdleTimeoutMs: env.BROWSER_NETWORKIDLE_TIMEOUT_MS,
      browserViewport: env.BROWSER_VIEWPORT_PARSED,
      proxyGridBaseUrl: env.PROXY_GRID_BASE_URL,
      proxyGridSecret: env.PROXY_GRID_SECRET,
      soaxApiUrl: env.SOAX_API_URL,
      soaxApiSecret: env.SOAX_API_SECRET,
      soaxCountry: env.SOAX_PROXY_COUNTRY,
      soaxProxyType: env.SOAX_PROXY_TYPE,
    },
  );
  const analyzeService = new AnalyzeService(
    jobs,
    sites,
    crawlTargets,
    queue,
    logger,
    env.SITE_REPORT_TTL_SEC,
    env.AI_PROMPT_VERSION,
    env.AI_SKIP_DEFAULT,
  );
  const ingestService = new IngestService(
    queue,
    crawlTargets,
    logger,
  );
  const opsDashboardService = new OpsDashboardService(jobs, queue);
  const analyzePublicLimit = env.ANALYZE_RATE_LIMIT_PUBLIC_PER_MIN ?? env.ANALYZE_RATE_LIMIT_PER_MIN;
  const analyzeOpsLimit = env.ANALYZE_RATE_LIMIT_OPS_PER_MIN ?? Math.max(analyzePublicLimit, 300);
  const analyzeProLimit = env.ANALYZE_RATE_LIMIT_PRO_PER_MIN ?? Math.max(analyzePublicLimit, 120);
  const ingestPublicLimit = env.INGEST_RATE_LIMIT_PUBLIC_PER_MIN
    ?? env.INGEST_RATE_LIMIT_PER_MIN
    ?? analyzePublicLimit;
  const ingestOpsLimit = env.INGEST_RATE_LIMIT_OPS_PER_MIN
    ?? Math.max(ingestPublicLimit, 120);
  const ingestProLimit = env.INGEST_RATE_LIMIT_PRO_PER_MIN
    ?? Math.max(ingestPublicLimit, 120);

  registerRoutes(
    app,
    {
      analyzeService,
      ingestService,
      trafficHistoryService,
      opsDashboardService,
      jobs,
      sites,
      crawlTargets,
      queue,
    },
    {
      apiKeys: [env.SITEJSON_API_KEY, env.SITEJSON_API_KEY_PREVIOUS].filter((value): value is string => Boolean(value)),
      opsApiKeys: [env.SITEJSON_OPS_API_KEY, env.SITEJSON_OPS_API_KEY_PREVIOUS].filter((value): value is string => Boolean(value)),
      proApiKeys: [env.SITEJSON_PRO_API_KEY, env.SITEJSON_PRO_API_KEY_PREVIOUS].filter((value): value is string => Boolean(value)),
      exposeApiDocs,
      analyzeRateLimits: {
        public: analyzePublicLimit,
        pro: analyzeProLimit,
        ops: analyzeOpsLimit,
      },
      analyzeClientRateLimits: {
        public: env.ANALYZE_CLIENT_RATE_LIMIT_PUBLIC_PER_MIN,
        pro: env.ANALYZE_CLIENT_RATE_LIMIT_PRO_PER_MIN,
        ops: env.ANALYZE_CLIENT_RATE_LIMIT_OPS_PER_MIN,
      },
      ingestRateLimits: {
        public: ingestPublicLimit,
        pro: ingestProLimit,
        ops: ingestOpsLimit,
      },
      insightsRateLimitPerMinute: env.INSIGHTS_RATE_LIMIT_PER_MIN,
      ingestMaxDomains: env.INGEST_MAX_DOMAINS,
    },
  );

  return {
    app,
    env,
    dependencies: {
      queue,
      jobs,
      sites,
      radarSnapshots,
      crawlTargets,
    },
    orchestrator,
    logger,
    freshnessTtlSec: env.SITE_REPORT_TTL_SEC,
    close: async () => {
      if (queue.close) {
        await queue.close();
      }
      if (pgPool) {
        await pgPool.end();
      }
      if (cacheRedis) {
        await cacheRedis.quit().catch(() => cacheRedis?.disconnect());
      }
    },
  };
};
