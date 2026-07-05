import { appendFile } from 'node:fs/promises';
import { Queue } from 'bullmq';
import { loadEnv } from '../config/env.js';
import { buildBullMqQueueName, buildRepeatableJobId, BullMqJobQueue, parseRedisUrl } from '../queue/bullmq.js';
import { ALL_QUEUE_NAMES, QUEUE_NAMES, type QueueName } from '../queue/names.js';
import type { QueueCounts, QueueJobPayload, RedisMemorySnapshot } from '../queue/interfaces.js';
import { createPostgresPool } from '../storage/postgres.js';

interface Options {
  durationHours: number;
  failOnWarnings: boolean;
  intervalSeconds: number;
  json: boolean;
  maxRank: number;
  outFile: string | null;
  staleHours: number;
  watch: boolean;
  windowHours: number;
}

type CountRow = { count: string };
type TimestampRow = { total: string; latest_updated_at: string | null };
type StatusRow = { status: string; count: string };

type RepeatableSummary = Record<QueueName, Array<{
  key: string;
  name: string;
  pattern?: string;
  next?: number;
}>>;

interface DbStatus {
  crawlTargetsTotal: number;
  radarTopRankTotal: number;
  firstRunCandidates: number;
  firstRunCandidatesTop100k: number;
  pendingFirstRun: number;
  stalePendingFirstRun: number;
  browserSuccessTopRank: number;
  browserFailedTopRank: number;
  radarSnapshotsTotal: number;
  radarLatestUpdatedAt: string | null;
  jobsLastWindowByStatus: Record<string, number>;
}

interface StatusReport {
  checkedAt: string;
  options: Options;
  env: {
    radarBulkBatchSize: number;
    radarBulkMinValidRows: number;
    cloudflareRadarTokenConfigured: boolean;
    ingestAutoFeedEnabled: boolean;
    ingestAutoFeedCron: string;
    ingestAutoFeedBatchSize: number;
    ingestAutoFeedMaxRank: number;
    backgroundBrowserMaxQueueDepth: number;
    backgroundBrowserDailyBudget: number;
    aiRetryFeedEnabled: boolean;
    redisFeedHardStopRatio: number;
  };
  db: DbStatus;
  queues: Record<QueueName, QueueCounts>;
  redisMemory: RedisMemorySnapshot | null;
  repeatables: RepeatableSummary;
  derived: {
    backgroundQueueDepth: number;
    backgroundQueueCapacity: number;
    wouldEnqueueNow: number;
    redisMemoryHardStop: boolean;
    radarBulkRepeatableRegistered: boolean;
    ingestAutoFeedRepeatableRegistered: boolean;
    aiRetryFeedRepeatableRegistered: boolean;
  };
  warnings: string[];
}

const parseArgs = (): Options => {
  const options: Options = {
    durationHours: 1,
    failOnWarnings: false,
    intervalSeconds: 300,
    json: false,
    maxRank: 1_000_000,
    outFile: null,
    staleHours: 24,
    watch: false,
    windowHours: 12,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--fail-on-warnings') {
      options.failOnWarnings = true;
      continue;
    }

    if (arg === '--watch') {
      options.watch = true;
      continue;
    }

    if (arg.startsWith('--duration-hours=')) {
      const value = Number.parseFloat(arg.split('=')[1] ?? '');
      if (Number.isFinite(value) && value > 0) {
        options.durationHours = value;
      }
      continue;
    }

    if (arg.startsWith('--interval-seconds=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) {
        options.intervalSeconds = value;
      }
      continue;
    }

    if (arg.startsWith('--out=')) {
      const value = (arg.split('=')[1] ?? '').trim();
      if (value) {
        options.outFile = value;
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

    if (arg.startsWith('--stale-hours=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) {
        options.staleHours = value;
      }
      continue;
    }

    if (arg.startsWith('--window-hours=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) {
        options.windowHours = value;
      }
    }
  }

  return options;
};

const toNumber = (value: string | null | undefined): number => {
  const parsed = Number.parseInt(value ?? '0', 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

const hasPurposeRepeatable = (
  repeatables: RepeatableSummary,
  queueName: QueueName,
  purpose: QueueJobPayload['purpose'],
): boolean => {
  const repeatableId = buildRepeatableJobId(queueName, purpose);
  return repeatables[queueName].some((item) => (
    item.name === repeatableId
    || item.key.includes(repeatableId)
    || item.key.includes(String(purpose))
  ));
};

const loadDbStatus = async (
  pool: ReturnType<typeof createPostgresPool>,
  options: Options,
): Promise<DbStatus> => {
  const [
    crawlTargetsTotal,
    radarTopRankTotal,
    firstRunCandidates,
    firstRunCandidatesTop100k,
    pendingFirstRun,
    stalePendingFirstRun,
    browserSuccessTopRank,
    browserFailedTopRank,
    radarSnapshots,
    jobsLastWindow,
  ] = await Promise.all([
    pool.query<CountRow>('SELECT COUNT(*)::text AS count FROM crawl_targets'),
    pool.query<CountRow>(
      `SELECT COUNT(*)::text AS count
       FROM crawl_targets
       WHERE radar_rank IS NOT NULL
         AND radar_rank > 0
         AND radar_rank <= $1`,
      [options.maxRank],
    ),
    pool.query<CountRow>(
      `SELECT COUNT(*)::text AS count
       FROM crawl_targets
       WHERE radar_rank IS NOT NULL
         AND radar_rank > 0
         AND radar_rank <= $1
         AND last_browser_at IS NULL
         AND last_browser_status IS NULL`,
      [options.maxRank],
    ),
    pool.query<CountRow>(
      `SELECT COUNT(*)::text AS count
       FROM crawl_targets
       WHERE radar_rank IS NOT NULL
         AND radar_rank > 0
         AND radar_rank <= 100000
         AND last_browser_at IS NULL
         AND last_browser_status IS NULL`,
    ),
    pool.query<CountRow>(
      `SELECT COUNT(*)::text AS count
       FROM crawl_targets
       WHERE radar_rank IS NOT NULL
         AND radar_rank > 0
         AND radar_rank <= $1
         AND last_browser_at IS NULL
         AND last_browser_status = 'pending'`,
      [options.maxRank],
    ),
    pool.query<CountRow>(
      `SELECT COUNT(*)::text AS count
       FROM crawl_targets
       WHERE radar_rank IS NOT NULL
         AND radar_rank > 0
         AND radar_rank <= $1
         AND last_browser_at IS NULL
         AND last_browser_status = 'pending'
         AND updated_at < NOW() - (($2::text || ' hours')::interval)`,
      [options.maxRank, options.staleHours],
    ),
    pool.query<CountRow>(
      `SELECT COUNT(*)::text AS count
       FROM crawl_targets
       WHERE radar_rank IS NOT NULL
         AND radar_rank > 0
         AND radar_rank <= $1
         AND last_browser_status = 'success'`,
      [options.maxRank],
    ),
    pool.query<CountRow>(
      `SELECT COUNT(*)::text AS count
       FROM crawl_targets
       WHERE radar_rank IS NOT NULL
         AND radar_rank > 0
         AND radar_rank <= $1
         AND last_browser_status = 'failed'`,
      [options.maxRank],
    ),
    pool.query<TimestampRow>(
      `SELECT COUNT(*)::text AS total,
              MAX(updated_at)::text AS latest_updated_at
       FROM radar_snapshots`,
    ),
    pool.query<StatusRow>(
      `SELECT status, COUNT(*)::text AS count
       FROM crawl_jobs
       WHERE updated_at >= NOW() - (($1::text || ' hours')::interval)
       GROUP BY status
       ORDER BY status ASC`,
      [options.windowHours],
    ),
  ]);

  return {
    crawlTargetsTotal: toNumber(crawlTargetsTotal.rows[0]?.count),
    radarTopRankTotal: toNumber(radarTopRankTotal.rows[0]?.count),
    firstRunCandidates: toNumber(firstRunCandidates.rows[0]?.count),
    firstRunCandidatesTop100k: toNumber(firstRunCandidatesTop100k.rows[0]?.count),
    pendingFirstRun: toNumber(pendingFirstRun.rows[0]?.count),
    stalePendingFirstRun: toNumber(stalePendingFirstRun.rows[0]?.count),
    browserSuccessTopRank: toNumber(browserSuccessTopRank.rows[0]?.count),
    browserFailedTopRank: toNumber(browserFailedTopRank.rows[0]?.count),
    radarSnapshotsTotal: toNumber(radarSnapshots.rows[0]?.total),
    radarLatestUpdatedAt: radarSnapshots.rows[0]?.latest_updated_at ?? null,
    jobsLastWindowByStatus: Object.fromEntries(
      jobsLastWindow.rows.map((row) => [row.status, toNumber(row.count)]),
    ),
  };
};

const loadRepeatables = async (
  queueNamePrefix: string,
  redisConnection: ReturnType<typeof parseRedisUrl>,
): Promise<RepeatableSummary> => {
  const summary = ALL_QUEUE_NAMES.reduce((acc, queueName) => {
    acc[queueName] = [];
    return acc;
  }, {} as RepeatableSummary);

  await Promise.all(ALL_QUEUE_NAMES.map(async (queueName) => {
    const queue = new Queue<QueueJobPayload>(
      buildBullMqQueueName(queueNamePrefix, queueName),
      { connection: redisConnection },
    );

    try {
      const repeatables = await queue.getRepeatableJobs(0, -1, true);
      summary[queueName] = repeatables.map((item) => ({
        key: item.key,
        name: item.name,
        pattern: item.pattern ?? undefined,
        next: item.next,
      }));
    } finally {
      await queue.close();
    }
  }));

  return summary;
};

const buildWarnings = (report: Omit<StatusReport, 'warnings'>): string[] => {
  const warnings: string[] = [];

  if (!report.env.cloudflareRadarTokenConfigured) {
    warnings.push('cloudflare_radar_token_missing');
  }
  if (!report.env.ingestAutoFeedEnabled) {
    warnings.push('ingest_auto_feed_disabled');
  }
  if (report.env.ingestAutoFeedMaxRank < report.options.maxRank) {
    warnings.push('ingest_auto_feed_max_rank_below_status_max_rank');
  }
  if (report.env.ingestAutoFeedEnabled && !report.derived.ingestAutoFeedRepeatableRegistered) {
    warnings.push('ingest_auto_feed_repeatable_missing');
  }
  if (report.env.aiRetryFeedEnabled && !report.derived.aiRetryFeedRepeatableRegistered) {
    warnings.push('ai_retry_feed_repeatable_missing');
  }
  if (!report.derived.radarBulkRepeatableRegistered) {
    warnings.push('radar_bulk_repeatable_missing');
  }
  if (report.derived.backgroundQueueDepth >= report.env.backgroundBrowserMaxQueueDepth) {
    warnings.push('background_queue_depth_at_or_above_limit');
  }
  if (report.derived.redisMemoryHardStop) {
    warnings.push('redis_memory_hard_stop');
  }
  if (report.db.stalePendingFirstRun > 0) {
    warnings.push('stale_pending_first_run_candidates');
  }
  if (report.db.radarSnapshotsTotal === 0) {
    warnings.push('radar_snapshots_empty');
  }
  if (report.db.radarSnapshotsTotal > 0 && !report.db.radarLatestUpdatedAt) {
    warnings.push('radar_latest_timestamp_missing');
  }

  return warnings;
};

const renderText = (report: StatusReport): string => {
  const lines = [
    `checked_at=${report.checkedAt}`,
    `max_rank=${report.options.maxRank}`,
    `window_hours=${report.options.windowHours}`,
    `radar_snapshots_total=${report.db.radarSnapshotsTotal}`,
    `radar_latest_updated_at=${report.db.radarLatestUpdatedAt ?? 'none'}`,
    `crawl_targets_total=${report.db.crawlTargetsTotal}`,
    `radar_top_rank_total=${report.db.radarTopRankTotal}`,
    `first_run_candidates=${report.db.firstRunCandidates}`,
    `first_run_candidates_top100k=${report.db.firstRunCandidatesTop100k}`,
    `pending_first_run=${report.db.pendingFirstRun}`,
    `stale_pending_first_run=${report.db.stalePendingFirstRun}`,
    `browser_success_top_rank=${report.db.browserSuccessTopRank}`,
    `browser_failed_top_rank=${report.db.browserFailedTopRank}`,
    `background_queue_depth=${report.derived.backgroundQueueDepth}`,
    `background_queue_capacity=${report.derived.backgroundQueueCapacity}`,
    `background_browser_max_queue_depth=${report.env.backgroundBrowserMaxQueueDepth}`,
    `background_browser_daily_budget=${report.env.backgroundBrowserDailyBudget}`,
    `would_enqueue_now=${report.derived.wouldEnqueueNow}`,
    `redis_memory_ratio=${report.redisMemory?.ratio ?? 'unknown'}`,
    `redis_memory_hard_stop=${report.derived.redisMemoryHardStop}`,
    `radar_bulk_repeatable_registered=${report.derived.radarBulkRepeatableRegistered}`,
    `ingest_auto_feed_enabled=${report.env.ingestAutoFeedEnabled}`,
    `ingest_auto_feed_repeatable_registered=${report.derived.ingestAutoFeedRepeatableRegistered}`,
    `ai_retry_feed_enabled=${report.env.aiRetryFeedEnabled}`,
    `ai_retry_feed_repeatable_registered=${report.derived.aiRetryFeedRepeatableRegistered}`,
  ];

  for (const queueName of ALL_QUEUE_NAMES) {
    const counts = report.queues[queueName];
    lines.push(
      `queue_${queueName}=waiting:${counts.waiting},active:${counts.active},delayed:${counts.delayed},prioritized:${counts.prioritized},failed:${counts.failed}`,
    );
  }

  const jobStatuses = Object.entries(report.db.jobsLastWindowByStatus)
    .map(([status, count]) => `${status}:${count}`)
    .join(',');
  lines.push(`jobs_last_window=${jobStatuses || 'none'}`);
  lines.push(`warnings=${report.warnings.length > 0 ? report.warnings.join(',') : 'none'}`);

  return `${lines.join('\n')}\n`;
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const writeReport = async (report: StatusReport, options: Options): Promise<void> => {
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
  if (options.outFile) {
    await appendFile(options.outFile, `${JSON.stringify(report)}\n`, 'utf8');
  }
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
  const redisConnection = parseRedisUrl(env.REDIS_URL, env.REDIS_PASSWORD);
  const queue = new BullMqJobQueue(
    redisConnection,
    env.QUEUE_NAME,
    { browser: env.QUEUE_CONCURRENCY_BROWSER, ingest: env.QUEUE_CONCURRENCY_INGEST },
    env.QUEUE_CONCURRENCY,
  );

  try {
    const buildReport = async (): Promise<StatusReport> => {
      const [db, queues, redisMemory, repeatables] = await Promise.all([
        loadDbStatus(pool, options),
        queue.getAllCounts(),
        queue.getRedisMemorySnapshot(),
        loadRepeatables(env.QUEUE_NAME, redisConnection),
      ]);

      const backgroundQueueDepth =
        queues.ingest.waiting + queues.ingest.delayed + queues.ingest.prioritized
        + queues.browser.waiting + queues.browser.delayed + queues.browser.prioritized;
      const backgroundQueueCapacity = Math.max(0, env.BACKGROUND_BROWSER_MAX_QUEUE_DEPTH - backgroundQueueDepth);
      const redisMemoryHardStop = Boolean(
        redisMemory?.ratio != null
        && redisMemory.maxBytes != null
        && redisMemory.usedBytes != null
        && redisMemory.ratio >= env.REDIS_FEED_HARD_STOP_RATIO,
      );
      const wouldEnqueueNow = env.INGEST_AUTO_FEED_ENABLED && !redisMemoryHardStop
        ? Math.min(
          db.firstRunCandidates,
          env.INGEST_AUTO_FEED_BATCH_SIZE,
          env.BACKGROUND_BROWSER_DAILY_BUDGET,
          backgroundQueueCapacity,
        )
        : 0;

      const reportWithoutWarnings: Omit<StatusReport, 'warnings'> = {
        checkedAt: new Date().toISOString(),
        options,
        env: {
          radarBulkBatchSize: env.RADAR_BULK_BATCH_SIZE,
          radarBulkMinValidRows: env.RADAR_BULK_MIN_VALID_ROWS,
          cloudflareRadarTokenConfigured: Boolean(env.CLOUDFLARE_API_TOKEN),
          ingestAutoFeedEnabled: env.INGEST_AUTO_FEED_ENABLED,
          ingestAutoFeedCron: env.INGEST_AUTO_FEED_CRON,
          ingestAutoFeedBatchSize: env.INGEST_AUTO_FEED_BATCH_SIZE,
          ingestAutoFeedMaxRank: env.INGEST_AUTO_FEED_MAX_RANK,
          backgroundBrowserMaxQueueDepth: env.BACKGROUND_BROWSER_MAX_QUEUE_DEPTH,
          backgroundBrowserDailyBudget: env.BACKGROUND_BROWSER_DAILY_BUDGET,
          aiRetryFeedEnabled: env.AI_RETRY_FEED_ENABLED,
          redisFeedHardStopRatio: env.REDIS_FEED_HARD_STOP_RATIO,
        },
        db,
        queues,
        redisMemory,
        repeatables,
        derived: {
          backgroundQueueDepth,
          backgroundQueueCapacity,
          wouldEnqueueNow,
          redisMemoryHardStop,
          radarBulkRepeatableRegistered: hasPurposeRepeatable(repeatables, QUEUE_NAMES.radar, 'radar-bulk-sync'),
          ingestAutoFeedRepeatableRegistered: hasPurposeRepeatable(repeatables, QUEUE_NAMES.ingest, 'ingest-auto-feed'),
          aiRetryFeedRepeatableRegistered: hasPurposeRepeatable(repeatables, QUEUE_NAMES.ingest, 'ai-retry-feed'),
        },
      };

      return {
        ...reportWithoutWarnings,
        warnings: buildWarnings(reportWithoutWarnings),
      };
    };

    const deadline = Date.now() + options.durationHours * 60 * 60 * 1000;
    while (true) {
      const report = await buildReport();
      await writeReport(report, options);
      if (options.failOnWarnings && report.warnings.length > 0) {
        process.exitCode = 2;
        return;
      }

      if (!options.watch || Date.now() >= deadline) {
        return;
      }
      await sleep(options.intervalSeconds * 1000);
    }
  } finally {
    await queue.close?.();
    await pool.end();
  }
};

main().catch((error) => {
  console.error('12h status check failed:', error);
  process.exit(1);
});
