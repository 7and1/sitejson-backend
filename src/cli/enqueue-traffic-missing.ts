import { loadEnv } from '../config/env.js';
import { BullMqJobQueue, parseRedisUrl } from '../queue/bullmq.js';
import { QUEUE_NAMES } from '../queue/names.js';
import type { QueueJobPayload } from '../queue/interfaces.js';
import { createPostgresPool } from '../storage/postgres.js';

interface EnqueueOptions {
  dryRun: boolean;
  batchSize: number;
  limit: number;
}

const parseArgs = (): EnqueueOptions => {
  const options: EnqueueOptions = {
    dryRun: false,
    batchSize: 500,
    limit: 10_000,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg.startsWith('--batch=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) {
        options.batchSize = value;
      }
    } else if (arg.startsWith('--limit=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) {
        options.limit = value;
      }
    }
  }

  return options;
};

const CANDIDATE_WHERE = `
  (sp.report_json->'trafficData'->>'monthlyVisits') IS NULL
  AND (ct.next_traffic_at IS NULL OR ct.next_traffic_at <= NOW())
`;

const MS_PER_DAY = 86_400_000;

const calculateDelayMs = (index: number, domainsPerDay: number): number => {
  if (domainsPerDay <= 0) return 0;
  const dayOffset = Math.floor(index / domainsPerDay);
  const position = index % domainsPerDay;
  const withinDayMs = Math.floor(((position + 0.5) / domainsPerDay) * MS_PER_DAY);
  return dayOffset * MS_PER_DAY + withinDayMs;
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
  const queue = new BullMqJobQueue(
    parseRedisUrl(env.REDIS_URL, env.REDIS_PASSWORD),
    env.QUEUE_NAME,
    {},
    env.QUEUE_CONCURRENCY,
  );

  try {
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM site_profiles sp
       LEFT JOIN crawl_targets ct ON ct.domain = sp.domain
       WHERE ${CANDIDATE_WHERE}`,
    );
    const totalCandidates = Number.parseInt(countResult.rows[0]?.count ?? '0', 10);
    console.log(`Domains missing traffic monthlyVisits: ${totalCandidates}`);

    if (options.dryRun || totalCandidates === 0) {
      return;
    }

    const traceId = `trc_traffic_missing_${Date.now()}`;
    let enqueued = 0;
    let lastDomain = '';
    const totalToEnqueue = Math.min(totalCandidates, options.limit);
    const spreadDays = Math.max(1, Math.trunc(env.TRAFFIC_REFRESH_SPREAD_DAYS || 5));
    const domainsPerDay = Math.max(1, Math.ceil(totalToEnqueue / spreadDays));
    console.log(`Spreading traffic refresh jobs over ${spreadDays} days (${domainsPerDay} per day target).`);

    while (enqueued < options.limit) {
      const batchLimit = Math.min(options.batchSize, options.limit - enqueued);
      if (batchLimit <= 0) break;

      const result = await pool.query<{ domain: string }>(
        `
        SELECT sp.domain
        FROM site_profiles sp
        LEFT JOIN crawl_targets ct ON ct.domain = sp.domain
        WHERE ${CANDIDATE_WHERE}
          AND sp.domain > $1
        ORDER BY sp.domain ASC
        LIMIT $2;
        `,
        [lastDomain, batchLimit],
      );

      if (result.rowCount === 0) {
        break;
      }

      const payloads: QueueJobPayload[] = result.rows.map((row, idx) => {
        const index = enqueued + idx;
        const delayMs = calculateDelayMs(index, domainsPerDay);
        return {
          jobId: `traffic-missing-${row.domain}`,
          domain: row.domain,
          traceId,
          source: 'system' as const,
          phase: QUEUE_NAMES.traffic,
          purpose: 'traffic-refresh' as const,
          delayMs,
        };
      });

      await queue.enqueueBulk(payloads, QUEUE_NAMES.traffic);

      enqueued += payloads.length;
      lastDomain = result.rows[result.rows.length - 1]?.domain ?? lastDomain;
      console.log(`Enqueued ${enqueued} / ${Math.min(totalCandidates, options.limit)} traffic refresh jobs`);
    }
  } finally {
    await queue.close();
    await pool.end();
  }
};

main().catch((error) => {
  console.error('Enqueue failed:', error);
  process.exit(1);
});
