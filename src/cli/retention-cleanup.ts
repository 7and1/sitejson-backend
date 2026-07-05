import { loadEnv } from '../config/env.js';
import { createPostgresPool } from '../storage/postgres.js';

type RetentionTarget = 'all' | 'jobs' | 'alternatives';

type Options = {
  alternativesGraceHours: number;
  apply: boolean;
  help: boolean;
  jobsRetentionDays: number;
  limit: number;
  target: RetentionTarget;
};

const parsePositiveInt = (value: string | undefined, fallback: number, max: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(max, parsed);
};

const parseTarget = (value: string | undefined): RetentionTarget => {
  if (value === 'jobs' || value === 'alternatives' || value === 'all') {
    return value;
  }
  throw new Error(`Invalid --only value: ${value ?? ''}. Expected all, jobs, or alternatives.`);
};

const printHelp = () => {
  console.log(`Delete bounded SiteJSON retention rows.

Dry-run by default:
  npm run retention:cleanup

Apply one bounded batch:
  npm run build
  npm run retention:cleanup -- --apply --limit=5000

Options:
  --apply                         delete rows; default is dry-run
  --dry-run                       force dry-run
  --jobs-retention-days=<n>       terminal crawl_jobs retention, default 90
  --alternatives-grace-hours=<n>  expired alternatives cache grace period, default 24
  --limit=<n>                     max rows per table per run, default 5000, max 100000
  --only=<all|jobs|alternatives>  restrict cleanup target, default all
  --help                          print this help
`);
};

const parseArgs = (): Options => {
  const options: Options = {
    alternativesGraceHours: 24,
    apply: false,
    help: false,
    jobsRetentionDays: 90,
    limit: 5_000,
    target: 'all',
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--dry-run') {
      options.apply = false;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--jobs-retention-days=')) {
      options.jobsRetentionDays = parsePositiveInt(arg.split('=')[1], options.jobsRetentionDays, 3650);
    } else if (arg.startsWith('--alternatives-grace-hours=')) {
      options.alternativesGraceHours = parsePositiveInt(arg.split('=')[1], options.alternativesGraceHours, 8760);
    } else if (arg.startsWith('--limit=')) {
      options.limit = parsePositiveInt(arg.split('=')[1], options.limit, 100_000);
    } else if (arg.startsWith('--only=')) {
      options.target = parseTarget(arg.split('=')[1]);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
};

const parseCount = (value: string | undefined): number => {
  const parsed = Number.parseInt(value ?? '0', 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

const main = async () => {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    return;
  }

  const env = loadEnv();
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for retention cleanup');
  }

  const pool = createPostgresPool(env.DATABASE_URL);

  try {
    if (options.target === 'all' || options.target === 'jobs') {
      const eligible = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM crawl_jobs
         WHERE status IN ('completed', 'failed')
           AND updated_at < NOW() - make_interval(days => $1)`,
        [options.jobsRetentionDays],
      );
      const count = parseCount(eligible.rows[0]?.count);
      console.log(`eligible_terminal_crawl_jobs=${count}`);
      console.log(`would_delete_terminal_crawl_jobs=${Math.min(count, options.limit)}`);

      if (options.apply && count > 0) {
        const deleted = await pool.query(
          `WITH picked AS (
             SELECT id
             FROM crawl_jobs
             WHERE status IN ('completed', 'failed')
               AND updated_at < NOW() - make_interval(days => $2)
             ORDER BY updated_at ASC, created_at ASC, id ASC
             LIMIT $1
             FOR UPDATE SKIP LOCKED
           )
           DELETE FROM crawl_jobs AS target
           USING picked
           WHERE target.id = picked.id`,
          [options.limit, options.jobsRetentionDays],
        );
        console.log(`deleted_terminal_crawl_jobs=${deleted.rowCount ?? 0}`);
      }
    }

    if (options.target === 'all' || options.target === 'alternatives') {
      const eligible = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM site_alternatives_cache
         WHERE expires_at < NOW() - (($1::text || ' hours')::interval)`,
        [options.alternativesGraceHours],
      );
      const count = parseCount(eligible.rows[0]?.count);
      console.log(`eligible_expired_alternatives_cache=${count}`);
      console.log(`would_delete_expired_alternatives_cache=${Math.min(count, options.limit)}`);

      if (options.apply && count > 0) {
        const deleted = await pool.query(
          `WITH picked AS (
             SELECT domain
             FROM site_alternatives_cache
             WHERE expires_at < NOW() - (($2::text || ' hours')::interval)
             ORDER BY expires_at ASC, domain ASC
             LIMIT $1
             FOR UPDATE SKIP LOCKED
           )
           DELETE FROM site_alternatives_cache AS target
           USING picked
           WHERE target.domain = picked.domain`,
          [options.limit, options.alternativesGraceHours],
        );
        console.log(`deleted_expired_alternatives_cache=${deleted.rowCount ?? 0}`);
      }
    }

    console.log(`dry_run=${!options.apply}`);
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  console.error('Retention cleanup failed:', error);
  process.exit(1);
});
