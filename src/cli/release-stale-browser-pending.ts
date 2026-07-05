import { loadEnv } from '../config/env.js';
import { createPostgresPool } from '../storage/postgres.js';

interface Options {
  apply: boolean;
  limit: number;
  staleHours: number;
  maxRank: number | null;
}

const MAX_INT32 = 2147483647;

const parseArgs = (): Options => {
  const options: Options = {
    apply: false,
    limit: 5_000,
    staleHours: 24,
    maxRank: null,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }

    if (arg.startsWith('--limit=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) {
        options.limit = value;
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

    if (arg.startsWith('--max-rank=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) {
        options.maxRank = value;
      }
    }
  }

  return options;
};

const main = async () => {
  const options = parseArgs();
  const env = loadEnv();

  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = createPostgresPool(env.DATABASE_URL);
  const maxRank = options.maxRank;

  try {
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM crawl_targets
       WHERE last_browser_status = 'pending'
         AND updated_at < NOW() - (($1::text || ' hours')::interval)
         AND (
           $2::int IS NULL
           OR (radar_rank IS NOT NULL AND radar_rank > 0 AND radar_rank <= $2)
         )`,
      [options.staleHours, maxRank],
    );

    const eligible = Number.parseInt(countResult.rows[0]?.count ?? '0', 10);
    console.log(`eligible_stale_pending=${eligible}`);
    console.log(`dry_run=${!options.apply}`);

    if (!options.apply || eligible === 0) {
      console.log(`would_release=${Math.min(eligible, options.limit)}`);
      return;
    }

    const result = await pool.query<{ domain: string; radar_rank: number | null }>(
       `WITH picked AS (
         SELECT ctid
         FROM crawl_targets
         WHERE last_browser_status = 'pending'
           AND updated_at < NOW() - (($2::text || ' hours')::interval)
           AND (
             $3::int IS NULL
             OR (radar_rank IS NOT NULL AND radar_rank > 0 AND radar_rank <= $3)
           )
         ORDER BY COALESCE(radar_rank, ${MAX_INT32}) ASC, updated_at ASC
         LIMIT $1
       )
       UPDATE crawl_targets AS target
       SET last_browser_status = CASE
             WHEN last_browser_at IS NOT NULL THEN 'success'
             ELSE NULL
           END,
           updated_at = NOW()
       FROM picked
       WHERE target.ctid = picked.ctid
       RETURNING target.domain, target.radar_rank`,
      [options.limit, options.staleHours, maxRank],
    );

    console.log(`released=${result.rowCount ?? 0}`);
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  console.error('Stale pending release failed:', error);
  process.exit(1);
});
