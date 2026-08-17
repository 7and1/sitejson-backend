import { buildApp } from './app.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { IngestWorker } from './workers/ingest-worker.js';
import { BrowserWorker } from './workers/browser-worker.js';
import { AsyncWorker } from './workers/async-worker.js';
import { TrafficWorker } from './workers/traffic-worker.js';
import { WhoisWorker } from './workers/whois-worker.js';
import { RadarSyncWorker } from './workers/radar-sync-worker.js';
import { setupScheduledJobs } from './workers/scheduler.js';
import { BrowserPool } from './core/browser-pool.js';
import type { QueueName } from './queue/names.js';
import { ALL_QUEUE_NAMES, QUEUE_NAMES } from './queue/names.js';
import type { Logger } from './observability/logger.js';

const HEARTBEAT_INTERVAL_MS = 10_000;

const parseWorkerQueues = (raw?: string): Set<QueueName> | null => {
  if (!raw?.trim()) return null; // all queues
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const valid = new Set<QueueName>();
  const invalid: string[] = [];
  for (const name of names) {
    if (ALL_QUEUE_NAMES.includes(name as QueueName)) {
      valid.add(name as QueueName);
    } else {
      invalid.push(name);
    }
  }
  if (invalid.length > 0 && valid.size === 0) {
    throw new Error(`WORKER_QUEUES contains only invalid names: ${names.join(', ')}. Valid: ${ALL_QUEUE_NAMES.join(', ')}`);
  }
  if (invalid.length > 0) {
    console.warn(`WORKER_QUEUES: ignoring invalid names: ${invalid.join(', ')}`);
  }
  return valid.size > 0 ? valid : null;
};

const startHeartbeat = (
  filePath: string | undefined,
  logger: Logger,
): ReturnType<typeof setInterval> | null => {
  if (!filePath) {
    return null;
  }

  const writeHeartbeat = async () => {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `${new Date().toISOString()}\n`, { mode: 0o644 });
    } catch (error) {
      logger.warn({
        module: 'worker',
        event: 'heartbeat_write_failed',
        file: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  void writeHeartbeat();
  const timer = setInterval(() => {
    void writeHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return timer;
};

const startWorker = async () => {
  const runtime = await buildApp(undefined, { runtimeRole: 'worker' });

  const allowedQueues = parseWorkerQueues(runtime.env.WORKER_QUEUES);
  const shouldRun = (q: QueueName) => !allowedQueues || allowedQueues.has(q);
  const shouldRunBrowserLane = shouldRun(QUEUE_NAMES.browser) || shouldRun(QUEUE_NAMES.browserRealtime);

  // Initialize browser pool if this worker handles browser queue
  let browserPool: BrowserPool | undefined;
  if (shouldRunBrowserLane && runtime.env.BROWSER_POOL_SIZE > 0) {
    browserPool = new BrowserPool(runtime.env.BROWSER_POOL_SIZE, runtime.logger);
    try {
      await browserPool.init();
    } catch (err) {
      runtime.logger.fatal({
        module: 'worker',
        event: 'browser_pool_init_failed',
        error: err instanceof Error ? err.message : String(err),
        poolSize: runtime.env.BROWSER_POOL_SIZE,
      });
      throw err;
    }
    runtime.orchestrator.setBrowserPool(browserPool);
  }

  const startPromises: Promise<void>[] = [];

  if (shouldRun('ingest')) {
    const ingestWorker = new IngestWorker(
      runtime.dependencies.queue,
      runtime.dependencies.crawlTargets,
      runtime.dependencies.jobs,
      runtime.logger,
      runtime.env.INGEST_AUTO_FEED_BATCH_SIZE,
      runtime.env.INGEST_AUTO_FEED_MAX_RANK,
      runtime.env.AI_RETRY_FEED_BATCH_SIZE,
      runtime.env.AI_RETRY_FEED_MAX_RANK,
      runtime.env.AI_PROMPT_VERSION,
      {
        ingestAutoFeedEnabled: runtime.env.INGEST_AUTO_FEED_ENABLED,
        aiRetryFeedEnabled: runtime.env.AI_RETRY_FEED_ENABLED,
        backgroundBrowserMaxQueueDepth: runtime.env.BACKGROUND_BROWSER_MAX_QUEUE_DEPTH,
        backgroundBrowserDailyBudget: runtime.env.BACKGROUND_BROWSER_DAILY_BUDGET,
        aiRetryDailyBudget: runtime.env.AI_RETRY_DAILY_BUDGET,
        redisFeedHardStopRatio: runtime.env.REDIS_FEED_HARD_STOP_RATIO,
        staleActiveJobHours: runtime.env.CRAWL_JOB_REAPER_STALE_HOURS,
        staleActiveJobLimit: runtime.env.CRAWL_JOB_REAPER_LIMIT,
      },
      runtime.dependencies.sites,
    );
    startPromises.push(ingestWorker.start());
  }

  if (shouldRun('browser')) {
    const browserWorker = new BrowserWorker(
      runtime.dependencies.queue,
      runtime.dependencies.sites,
      runtime.dependencies.crawlTargets,
      runtime.dependencies.jobs,
      runtime.orchestrator,
      runtime.logger,
      runtime.env.AI_PROMPT_VERSION,
      QUEUE_NAMES.browser,
    );
    startPromises.push(browserWorker.start());
  }

  if (shouldRun('browser_realtime')) {
    const realtimeBrowserWorker = new BrowserWorker(
      runtime.dependencies.queue,
      runtime.dependencies.sites,
      runtime.dependencies.crawlTargets,
      runtime.dependencies.jobs,
      runtime.orchestrator,
      runtime.logger,
      runtime.env.AI_PROMPT_VERSION,
      QUEUE_NAMES.browserRealtime,
    );
    startPromises.push(realtimeBrowserWorker.start());
  }

  if (shouldRun('async')) {
    const asyncWorker = new AsyncWorker(
      runtime.dependencies.queue,
      runtime.dependencies.sites,
      runtime.dependencies.crawlTargets,
      runtime.dependencies.jobs,
      runtime.orchestrator,
      runtime.logger,
      runtime.env.AI_PROMPT_VERSION,
      runtime.env.AHREFS_DR_CACHE_TTL_HOURS,
    );
    startPromises.push(asyncWorker.start());
  }

  if (shouldRun('traffic')) {
    const trafficWorker = new TrafficWorker(
      runtime.dependencies.queue,
      runtime.dependencies.sites,
      runtime.dependencies.crawlTargets,
      runtime.dependencies.jobs,
      runtime.orchestrator,
      runtime.logger,
      runtime.env.TRAFFIC_REFRESH_SPREAD_DAYS,
      runtime.env.TRAFFIC_SUCCESS_TTL_HOURS,
      runtime.env.TRAFFIC_NO_DATA_COOLDOWN_HOURS,
      runtime.env.TRAFFIC_NO_DATA_MAX_COOLDOWN_HOURS,
      runtime.env.TRAFFIC_FASTLANE_BATCH_SIZE,
      runtime.env.TRAFFIC_FASTLANE_MAX_SNAPSHOT_AGE_DAYS,
      runtime.env.TRAFFIC_MONTHLY_SEED_ENABLED,
      {
        enabled: runtime.env.TRAFFIC_SIMILARWEB_SEED_ENABLED,
        baseUrl: runtime.env.TRAFFIC_SIMILARWEB_BASE_URL,
        apiKey: runtime.env.TRAFFIC_SIMILARWEB_API_KEY,
        batchSize: runtime.env.TRAFFIC_SIMILARWEB_SEED_BATCH_SIZE,
        maxSnapshotAgeDays: runtime.env.TRAFFIC_FASTLANE_MAX_SNAPSHOT_AGE_DAYS,
        timeoutMs: runtime.env.TRAFFIC_SIMILARWEB_TIMEOUT_MS,
        followupInitialDelayMs: runtime.env.TRAFFIC_SIMILARWEB_FOLLOWUP_INITIAL_DELAY_MS,
        followupPollIntervalMs: runtime.env.TRAFFIC_SIMILARWEB_FOLLOWUP_POLL_INTERVAL_MS,
        followupMaxWaitMs: runtime.env.TRAFFIC_SIMILARWEB_FOLLOWUP_MAX_WAIT_MS,
      },
    );
    startPromises.push(trafficWorker.start());
  }

  if (shouldRun('whois')) {
    const whoisWorker = new WhoisWorker(
      runtime.dependencies.queue,
      runtime.dependencies.sites,
      runtime.dependencies.crawlTargets,
      runtime.dependencies.jobs,
      runtime.orchestrator,
      runtime.logger,
      runtime.env.WHOIS_SUCCESS_TTL_HOURS,
      runtime.env.WHOIS_NO_DATA_COOLDOWN_HOURS,
      runtime.env.WHOIS_NO_DATA_MAX_COOLDOWN_HOURS,
    );
    startPromises.push(whoisWorker.start());
  }

  if (shouldRun('radar')) {
    const radarWorker = new RadarSyncWorker(
      runtime.dependencies.radarSnapshots,
      runtime.dependencies.crawlTargets,
      runtime.dependencies.jobs,
      runtime.dependencies.queue,
      runtime.logger,
      runtime.env.CLOUDFLARE_API_TOKEN,
      runtime.env.RADAR_DATASET_TYPE,
      runtime.env.PROVIDER_TIMEOUT_MS,
      runtime.env.PROVIDER_RETRY_ATTEMPTS,
      runtime.env.PROVIDER_RETRY_BASE_MS,
      runtime.env.RADAR_BULK_BATCH_SIZE,
      runtime.env.RADAR_BULK_MIN_VALID_ROWS,
    );
    startPromises.push(
      runtime.dependencies.queue.consume('radar', async (payload) => {
        await radarWorker.process(payload);
      }),
    );
  }

  await Promise.all(startPromises);

  // Register scheduled jobs only on the ingest worker to avoid duplicates
  if (shouldRun('ingest')) {
    await setupScheduledJobs(runtime.dependencies.queue, runtime.logger, {
      TRAFFIC_REFRESH_START_DAY: runtime.env.TRAFFIC_REFRESH_START_DAY,
      TRAFFIC_MONTHLY_SEED_ENABLED: runtime.env.TRAFFIC_MONTHLY_SEED_ENABLED,
      TRAFFIC_FASTLANE_ENABLED: runtime.env.TRAFFIC_FASTLANE_ENABLED,
      TRAFFIC_FASTLANE_CRON: runtime.env.TRAFFIC_FASTLANE_CRON,
      TRAFFIC_SIMILARWEB_SEED_ENABLED: runtime.env.TRAFFIC_SIMILARWEB_SEED_ENABLED,
      TRAFFIC_SIMILARWEB_SEED_CRON: runtime.env.TRAFFIC_SIMILARWEB_SEED_CRON,
      INGEST_AUTO_FEED_ENABLED: runtime.env.INGEST_AUTO_FEED_ENABLED,
      INGEST_AUTO_FEED_CRON: runtime.env.INGEST_AUTO_FEED_CRON,
      AI_RETRY_FEED_ENABLED: runtime.env.AI_RETRY_FEED_ENABLED,
      AI_RETRY_FEED_CRON: runtime.env.AI_RETRY_FEED_CRON,
    });
  }

  const activeQueues = allowedQueues ? [...allowedQueues].join(',') : 'all';
  runtime.logger.info({ module: 'worker', event: 'started', queues: activeQueues, browserPool: !!browserPool });
  const heartbeatTimer = startHeartbeat(runtime.env.WORKER_HEARTBEAT_FILE, runtime.logger);

  // --- Graceful shutdown ---
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    runtime.logger.info({ module: 'worker', event: 'shutdown_started', signal });

    // must exceed the longest provider deadline this worker can run (history
    // compute-on-miss: 122s on worker-io), and stay below stop_grace_period
    const shutdownTimeoutMs = runtime.env.WORKER_SHUTDOWN_TIMEOUT_MS;
    const forceExitTimer = setTimeout(() => {
      runtime.logger.error({ module: 'worker', event: 'shutdown_timeout', timeout_ms: shutdownTimeoutMs });
      process.exit(1);
    }, shutdownTimeoutMs);
    forceExitTimer.unref(); // Don't keep process alive just for the timer

    try {
      await runtime.close();
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      if (browserPool) {
        await browserPool.close();
      }
      runtime.logger.info({ module: 'worker', event: 'shutdown_complete' });
    } catch (err) {
      runtime.logger.error({
        module: 'worker',
        event: 'shutdown_error',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(forceExitTimer);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // --- Crash safety ---
  process.on('uncaughtException', (err) => {
    runtime.logger.fatal({
      module: 'worker',
      event: 'uncaught_exception',
      error: err.message,
      stack: err.stack,
    });
    shutdown('uncaughtException').catch(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    runtime.logger.error({
      module: 'worker',
      event: 'unhandled_rejection',
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    // Do not exit — BullMQ handles individual job failures.
    // Log for visibility so the team can investigate the source.
  });
};

startWorker().catch((error) => {
  console.error('Failed to start worker:', error);
  process.exit(1);
});
