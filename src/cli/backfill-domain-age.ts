import { loadEnv } from '../config/env.js';
import { createPostgresPool } from '../storage/postgres.js';

interface BackfillOptions {
  dryRun: boolean;
  batchSize: number;
  limit: number | null;
}

const parseArgs = (): BackfillOptions => {
  const options: BackfillOptions = {
    dryRun: false,
    batchSize: 1000,
    limit: null,
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
  (report_json->'trafficData'->>'domainAgeYears') IS NULL
  AND (report_json->'trafficData'->'whois'->>'createdAt') IS NOT NULL
  AND (report_json->'trafficData'->'whois'->>'createdAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
`;

const main = async () => {
  const options = parseArgs();
  const env = loadEnv();

  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for backfill');
  }

  const pool = createPostgresPool(env.DATABASE_URL);

  try {
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM site_profiles WHERE ${CANDIDATE_WHERE}`,
    );
    const totalCandidates = Number.parseInt(countResult.rows[0]?.count ?? '0', 10);
    console.log(`Candidates missing domainAgeYears (with whois.createdAt): ${totalCandidates}`);

    if (options.dryRun || totalCandidates === 0) {
      return;
    }

    let updated = 0;
    const maxUpdates = options.limit ?? Number.POSITIVE_INFINITY;

    while (updated < maxUpdates) {
      const batchLimit = Math.min(options.batchSize, maxUpdates - updated);
      if (batchLimit <= 0) break;

      const result = await pool.query<{ domain: string }>(
        `
        WITH targets AS (
          SELECT domain,
                 (report_json->'trafficData'->'whois'->>'createdAt') AS created_at
          FROM site_profiles
          WHERE ${CANDIDATE_WHERE}
          LIMIT $1
        )
        UPDATE site_profiles AS sp
        SET report_json = jsonb_set(
          sp.report_json,
          '{trafficData,domainAgeYears}',
          to_jsonb(
            ROUND(
              GREATEST(
                0,
                (EXTRACT(EPOCH FROM (now() - targets.created_at::timestamptz)) / 86400 / 365.25)
              )::numeric,
              1
            )
          ),
          true
        )
        FROM targets
        WHERE sp.domain = targets.domain
        RETURNING sp.domain;
        `,
        [batchLimit],
      );

      const batchUpdated = result.rowCount ?? 0;
      updated += batchUpdated;
      console.log(`Updated ${updated} / ${Math.min(totalCandidates, maxUpdates)} domainAgeYears`);

      if (batchUpdated < batchLimit) {
        break;
      }
    }
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  console.error('Backfill failed:', error);
  process.exit(1);
});
