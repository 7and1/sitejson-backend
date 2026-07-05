import { randomUUID } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { BullMqJobQueue, parseRedisUrl } from '../queue/bullmq.js';
import { QUEUE_NAMES } from '../queue/names.js';
import type { QueueJobPayload } from '../queue/interfaces.js';
import { createPostgresPool, PostgresCrawlTargetRepository } from '../storage/postgres.js';

interface Options {
  apply: boolean;
  batchSize: number;
  limit: number;
  maxRank: number;
  maxQueueDepth: number;
  dailyBudget: number;
  runTag: string;
}

const parseArgs = (): Options => {
  const options: Options = {
    apply: false,
    batchSize: 250,
    limit: 500,
    maxRank: 1_000_000,
    maxQueueDepth: 5_000,
    dailyBudget: 10_000,
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
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) {
        options.batchSize = value;
      }
      continue;
    }

    if (arg.startsWith('--limit=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) {
        options.limit = value;
      }
      continue;
    }

    if (arg.startsWith('--max-rank=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) {
        options.maxRank = value;
      }
      continue;
    }

    if (arg.startsWith('--max-queue-depth=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value >= 0) {
        options.maxQueueDepth = value;
      }
      continue;
    }

    if (arg.startsWith('--daily-budget=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value >= 0) {
        options.dailyBudget = value;
      }
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
    throw new Error('DATABASE_URL is required');
  }
  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL is required');
  }

  const pool = createPostgresPool(env.DATABASE_URL);
  const crawlTargets = new PostgresCrawlTargetRepository(pool);
  const queue = new BullMqJobQueue(
    parseRedisUrl(env.REDIS_URL, env.REDIS_PASSWORD),
    env.QUEUE_NAME,
    { browser: env.QUEUE_CONCURRENCY_BROWSER, ingest: env.QUEUE_CONCURRENCY_INGEST },
    env.QUEUE_CONCURRENCY,
  );

  try {
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM crawl_targets
       WHERE radar_rank IS NOT NULL
         AND radar_rank > 0
         AND radar_rank <= $1
         AND last_browser_at IS NULL
         AND last_browser_status IS NULL`,
      [options.maxRank],
    );
    const candidateCount = Number.parseInt(countResult.rows[0]?.count ?? '0', 10);
    const queueDepth = await getGuardedQueueDepth(queue);
    const queueCapacity = Math.max(0, options.maxQueueDepth - queueDepth);
    const maxByBudget = Math.min(options.limit, options.dailyBudget);
    const wouldEnqueue = Math.min(candidateCount, maxByBudget, queueCapacity);

    console.log(`candidate_count=${candidateCount}`);
    console.log(`background_queue_depth=${queueDepth}`);
    console.log(`would_enqueue=${wouldEnqueue}`);
    console.log(`dry_run=${!options.apply}`);

    if (!options.apply || wouldEnqueue <= 0) {
      return;
    }

    let enqueued = 0;
    const traceId = `trc_first_run_${options.runTag}`;

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

      const claimed = await crawlTargets.claimHighRankFirstRunDomains(batchLimit, {
        maxRadarRank: options.maxRank,
      });
      if (claimed.length === 0) {
        break;
      }

      const payloads: QueueJobPayload[] = claimed.map((item) => ({
        jobId: `manual-first-run-${item.domain}-${randomUUID()}`,
        domain: item.domain,
        traceId,
        source: 'system',
        dispatchLane: 'background',
        phase: QUEUE_NAMES.ingest,
        purpose: 'analysis',
        priority: 'high',
        isHighValue: item.isHighValue,
      }));

      try {
        await queue.enqueueBulk(payloads, QUEUE_NAMES.ingest);
      } catch (error) {
        await crawlTargets.releaseClaimedFirstRunDomains(claimed.map((item) => item.domain));
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
  console.error('First-run enqueue failed:', error);
  process.exit(1);
});
