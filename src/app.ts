import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { createLogger } from './observability/logger.js';
import { loadEnv } from './config/env.js';
import { registerRoutes } from './api/routes.js';
import { InMemoryJobQueue } from './queue/in-memory.js';
import { BullMqJobQueue, parseRedisUrl } from './queue/bullmq.js';
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
import { Orchestrator } from './core/orchestrator.js';
import {
  AdsProvider,
  AiProvider,
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

const buildProviderOptions = (env: ReturnType<typeof loadEnv>) => ({
  timeoutMs: env.PROVIDER_TIMEOUT_MS,
  retryAttempts: env.PROVIDER_RETRY_ATTEMPTS,
  retryBaseMs: env.PROVIDER_RETRY_BASE_MS,
});

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

const applyCorsHeaders = (reply: { header: (name: string, value: string) => void }) => {
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
  reply.header('access-control-allow-headers', 'authorization,content-type,x-api-key');
};

export const buildApp = async (
  provided?: Partial<AppDependencies>,
): Promise<AppRuntime> => {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const app = Fastify({ logger: false });

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

  let pgPool: Pool | null = null;

  app.addHook('onRequest', async (_request, reply) => {
    applyCorsHeaders(reply);
  });

  app.options('/*', async (_request, reply) => {
    applyCorsHeaders(reply);
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
      pgPool = createPostgresPool(env.DATABASE_URL);
      await ensurePostgresSchema(pgPool);

      return {
        sites: provided?.sites ?? new PostgresSiteRepository(pgPool),
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
        parseRedisUrl(env.REDIS_URL),
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
  });
  const radarSyncService = new RadarSyncService(queue, logger);

  const orchestrator = new Orchestrator(
    [
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
        env.CODEX_WIRE_API,
      ),
    ],
    logger,
    {
      timeoutMs: env.PROVIDER_TIMEOUT_MS,
      retryAttempts: env.PROVIDER_RETRY_ATTEMPTS,
      retryBaseMs: env.PROVIDER_RETRY_BASE_MS,
      userAgent: env.USER_AGENT,
      aiEnableAutoTrigger: env.AI_ENABLE_AUTO_TRIGGER,
      aiAutoTriggerRankLimit: env.AI_AUTO_TRIGGER_RANK_LIMIT,
      browserEnabled: env.BROWSER_ENABLED,
      browserTimeoutMs: env.BROWSER_TIMEOUT_MS,
      browserHighValueTimeoutMs: env.BROWSER_TIMEOUT_MS_HIGH_VALUE,
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

  registerRoutes(
    app,
    {
      analyzeService,
      ingestService,
      opsDashboardService,
      jobs,
      sites,
      queue,
    },
    {
      apiKeys: env.NODE_ENV === 'production'
        ? [env.SITEJSON_API_KEY, env.SITEJSON_API_KEY_PREVIOUS].filter((value): value is string => Boolean(value))
        : undefined,
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
    },
  };
};
