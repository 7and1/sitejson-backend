import { loadEnv } from '../config/env.js';
import { BullMqJobQueue, parseRedisUrl } from '../queue/bullmq.js';
import { QUEUE_NAMES } from '../queue/names.js';
import type { QueueJobPayload } from '../queue/interfaces.js';
import { createPostgresPool, PostgresCrawlTargetRepository } from '../storage/postgres.js';

interface EnqueueOptions {
  apply: boolean;
  batchSize: number;
  limit: number;
  maxRank: number;
  maxQueueDepth: number;
  dailyBudget: number;
  refreshTtlHours: number;
  runTag: string;
}

const parsePositiveInt = (value: string | undefined): number | null => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseNonNegativeInt = (value: string | undefined): number | null => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const parseArgs = (): EnqueueOptions => {
  const options: EnqueueOptions = {
    apply: false,
    batchSize: 250,
    limit: 500,
    maxRank: 100_000,
    maxQueueDepth: 5_000,
    dailyBudget: 10_000,
    refreshTtlHours: 720,
    runTag: String(Date.now()),
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }

    if (arg === '--dry-run') {
      options.apply = false;
      continue;
    }

    if (arg.startsWith('--batch=')) {
      options.batchSize = parsePositiveInt(arg.split('=')[1]) ?? options.batchSize;
      continue;
    }

    if (arg.startsWith('--batch-size=')) {
      options.batchSize = parsePositiveInt(arg.split('=')[1]) ?? options.batchSize;
      continue;
    }

    if (arg.startsWith('--limit=')) {
      options.limit = parsePositiveInt(arg.split('=')[1]) ?? options.limit;
      continue;
    }

    if (arg.startsWith('--max-rank=')) {
      options.maxRank = parsePositiveInt(arg.split('=')[1]) ?? options.maxRank;
      continue;
    }

    if (arg.startsWith('--max-queue-depth=')) {
      options.maxQueueDepth = parseNonNegativeInt(arg.split('=')[1]) ?? options.maxQueueDepth;
      continue;
    }

    if (arg.startsWith('--daily-budget=')) {
      options.dailyBudget = parseNonNegativeInt(arg.split('=')[1]) ?? options.dailyBudget;
      continue;
    }

    if (arg.startsWith('--refresh-ttl-hours=')) {
      options.refreshTtlHours = parsePositiveInt(arg.split('=')[1]) ?? options.refreshTtlHours;
      continue;
    }

    if (arg.startsWith('--run-tag=')) {
      const value = (arg.split('=')[1] ?? '').trim();
      if (value) {
        options.runTag = value;
      }
    }
  }

  return options;
};

const getGuardedQueueDepth = async (queue: BullMqJobQueue) => {
  const [ingestCounts, browserCounts] = await Promise.all([
    queue.getCounts(QUEUE_NAMES.ingest),
    queue.getCounts(QUEUE_NAMES.browser),
  ]);
  return ingestCounts.waiting + ingestCounts.delayed + ingestCounts.prioritized
    + browserCounts.waiting + browserCounts.delayed + browserCounts.prioritized;
};

const main = async () => {
  const options = parseArgs();
  const env = loadEnv();

  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for enqueue');
  }
  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL is required for enqueue');
  }

  const pool = createPostgresPool(env.DATABASE_URL);
  const crawlTargets = new PostgresCrawlTargetRepository(pool);
  const queue = new BullMqJobQueue(
    parseRedisUrl(env.REDIS_URL, env.REDIS_PASSWORD),
    env.QUEUE_NAME,
    { browser: env.QUEUE_CONCURRENCY_BROWSER, ingest: env.QUEUE_CONCURRENCY_INGEST },
    env.QUEUE_CONCURRENCY,
  );

  const claimOptions = {
    maxRadarRank: options.maxRank,
    refreshTtlHours: options.refreshTtlHours,
  };

  try {
    const candidateCount = await crawlTargets.countDueBrowserRefreshDomains(claimOptions);
    const queueDepth = await getGuardedQueueDepth(queue);
    const queueCapacity = Math.max(0, options.maxQueueDepth - queueDepth);
    const maxByBudget = Math.min(options.limit, options.dailyBudget);
    const wouldEnqueue = Math.min(candidateCount, maxByBudget, queueCapacity);

    console.log(`candidate_count=${candidateCount}`);
    console.log(`background_queue_depth=${queueDepth}`);
    console.log(`would_enqueue=${wouldEnqueue}`);
    console.log(`dry_run=${!options.apply}`);
    console.log(`max_rank=${options.maxRank}`);
    console.log(`refresh_ttl_hours=${options.refreshTtlHours}`);

    if (!options.apply || wouldEnqueue <= 0) {
      return;
    }

    const traceId = `trc_hv_browser_refresh_${options.runTag}`;
    let enqueued = 0;

    while (enqueued < maxByBudget) {
      const currentDepth = await getGuardedQueueDepth(queue);
      const remainingQueueCapacity = Math.max(0, options.maxQueueDepth - currentDepth);
      if (remainingQueueCapacity <= 0) {
        console.log('queue_depth_guard_reached=true');
        break;
      }

      const batchLimit = Math.min(
        options.batchSize,
        maxByBudget - enqueued,
        remainingQueueCapacity,
      );
      if (batchLimit <= 0) {
        break;
      }

      const claimed = await crawlTargets.claimDueBrowserRefreshDomains(batchLimit, claimOptions);
      if (claimed.length === 0) {
        break;
      }

      const payloads: QueueJobPayload[] = claimed.map((item) => ({
        jobId: `hv-browser-refresh-${options.runTag}-${item.domain}`,
        domain: item.domain,
        traceId,
        source: 'system',
        dispatchLane: 'background',
        phase: QUEUE_NAMES.browser,
        purpose: 'browser',
        priority: 'high',
        forceRefresh: true,
        skipAi: true,
        isHighValue: item.isHighValue,
      }));

      try {
        await queue.enqueueBulk(payloads, QUEUE_NAMES.browser);
      } catch (error) {
        await crawlTargets.releaseClaimedBrowserRefreshDomains(claimed);
        throw error;
      }

      enqueued += payloads.length;
      console.log(`enqueued=${enqueued}`);
    }
  } finally {
    await queue.close();
    await pool.end();
  }
};

main().catch((error) => {
  console.error('High-value browser refresh enqueue failed:', error);
  process.exit(1);
});
