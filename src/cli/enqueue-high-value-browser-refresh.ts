import { loadEnv } from '../config/env.js';
import { BullMqJobQueue, parseRedisUrl } from '../queue/bullmq.js';
import { QUEUE_NAMES } from '../queue/names.js';
import type { QueueJobPayload } from '../queue/interfaces.js';
import { createPostgresPool } from '../storage/postgres.js';

interface EnqueueOptions {
  dryRun: boolean;
  batchSize: number;
  limit: number;
  runTag: string;
  minRank: number | null;
  maxRank: number;
  spreadDays: number;
}

const parseArgs = (): EnqueueOptions => {
  const options: EnqueueOptions = {
    dryRun: false,
    batchSize: 500,
    limit: 10_000,
    runTag: String(Date.now()),
    minRank: null,
    maxRank: 100_000,
    spreadDays: 0,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg.startsWith('--batch=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) options.batchSize = value;
      continue;
    }

    if (arg.startsWith('--limit=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) options.limit = value;
      continue;
    }

    if (arg.startsWith('--run-tag=')) {
      const value = (arg.split('=')[1] ?? '').trim();
      if (value) options.runTag = value;
      continue;
    }

    if (arg.startsWith('--min-rank=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) options.minRank = value;
      continue;
    }

    if (arg.startsWith('--max-rank=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value >= 0) options.maxRank = value;
      continue;
    }

    if (arg.startsWith('--spread-days=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) options.spreadDays = value;
      continue;
    }
  }

  return options;
};

const MAX_INT32 = 2147483647;
const MS_PER_DAY = 86_400_000;

const calculateDelayMs = (index: number, domainsPerDay: number): number => {
  if (domainsPerDay <= 0) return 0;
  const dayOffset = Math.floor(index / domainsPerDay);
  const position = index % domainsPerDay;
  const withinDayMs = Math.floor(((position + 0.5) / domainsPerDay) * MS_PER_DAY);
  return dayOffset * MS_PER_DAY + withinDayMs;
};

const buildCandidateWhere = (options: EnqueueOptions) => {
  const clauses: string[] = [];
  const params: Array<number> = [];

  clauses.push('ct.is_high_value = true');

  if (options.maxRank > 0) {
    params.push(options.maxRank);
    if (options.minRank && options.minRank > 0) {
      params.push(options.minRank);
      clauses.push('(ct.radar_rank IS NOT NULL AND ct.radar_rank <= $1 AND ct.radar_rank >= $2)');
    } else {
      clauses.push('(ct.radar_rank IS NOT NULL AND ct.radar_rank <= $1)');
    }
  }

  return {
    where: `(${clauses.join(' OR ')})`,
    params,
  };
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
    parseRedisUrl(env.REDIS_URL),
    env.QUEUE_NAME,
    {},
    env.QUEUE_CONCURRENCY,
  );

  const candidate = buildCandidateWhere(options);
  const traceId = `trc_hv_browser_refresh_${options.runTag}`;

  try {
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM crawl_targets ct
       WHERE ${candidate.where}`,
      candidate.params,
    );

    const totalCandidates = Number.parseInt(countResult.rows[0]?.count ?? '0', 10);
    console.log(`High-value browser refresh candidates: ${totalCandidates}`);

    if (options.dryRun || totalCandidates === 0) {
      return;
    }

    const totalToEnqueue = Math.min(totalCandidates, options.limit);
    const spreadDays = Math.max(0, Math.trunc(options.spreadDays));
    const domainsPerDay = spreadDays > 0 ? Math.max(1, Math.ceil(totalToEnqueue / spreadDays)) : 0;

    if (spreadDays > 0) {
      console.log(`Spreading browser refresh jobs over ${spreadDays} days (${domainsPerDay} per day target).`);
    }

    let enqueued = 0;
    let lastRankKey = 0;
    let lastDomain = '';

    while (enqueued < options.limit) {
      const batchLimit = Math.min(options.batchSize, options.limit - enqueued);
      if (batchLimit <= 0) break;

      const rankParams = candidate.params;
      const paginationParams: Array<number | string> = [...rankParams, lastRankKey, lastDomain, batchLimit];
      const result = await pool.query<{ domain: string; is_high_value: boolean; radar_rank: number | null }>(
        `
        SELECT ct.domain, ct.is_high_value, ct.radar_rank
        FROM crawl_targets ct
        WHERE ${candidate.where}
          AND (COALESCE(ct.radar_rank, ${MAX_INT32}), ct.domain) > ($${rankParams.length + 1}::int, $${rankParams.length + 2}::text)
        ORDER BY COALESCE(ct.radar_rank, ${MAX_INT32}) ASC, ct.domain ASC
        LIMIT $${rankParams.length + 3};
        `,
        paginationParams,
      );

      if (result.rowCount === 0) {
        break;
      }

      const payloads: QueueJobPayload[] = result.rows.map((row, idx) => {
        const index = enqueued + idx;
        const radarRank = typeof row.radar_rank === 'number' ? row.radar_rank : null;
        const isHighValue = row.is_high_value || (typeof radarRank === 'number' && radarRank > 0 && radarRank <= 100_000);
        const delayMs = domainsPerDay > 0 ? calculateDelayMs(index, domainsPerDay) : undefined;

        return {
          jobId: `hv-browser-refresh-${options.runTag}-${row.domain}`,
          domain: row.domain,
          traceId,
          source: 'system' as const,
          dispatchLane: 'background' as const,
          phase: QUEUE_NAMES.browser,
          purpose: 'browser' as const,
          priority: 'high' as const,
          forceRefresh: true,
          skipAi: true,
          isHighValue,
          ...(delayMs ? { delayMs } : {}),
        };
      });

      await queue.enqueueBulk(payloads, QUEUE_NAMES.browser);

      enqueued += payloads.length;
      const lastRow = result.rows[result.rows.length - 1];
      lastRankKey = lastRow?.radar_rank ?? MAX_INT32;
      lastDomain = lastRow?.domain ?? lastDomain;

      console.log(`Enqueued ${enqueued} / ${totalToEnqueue} high-value browser refresh jobs`);

      if (payloads.length < batchLimit) {
        break;
      }
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
