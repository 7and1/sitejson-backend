import { loadEnv } from '../config/env.js';
import { createPostgresPool } from '../storage/postgres.js';

interface CleanupOptions {
  dryRun: boolean;
  batchSize: number;
  limit: number | null;
}

const parseArgs = (): CleanupOptions => {
  const options: CleanupOptions = {
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

const LEGACY_WHERE = `
  report_json ? 'score'
  OR (
    jsonb_typeof(report_json->'seo') = 'object'
    AND (report_json->'seo') ? 'contacts'
  )
`;

const main = async () => {
  const options = parseArgs();
  const env = loadEnv();

  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for cleanup');
  }

  const pool = createPostgresPool(env.DATABASE_URL);

  try {
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM site_profiles WHERE ${LEGACY_WHERE}`,
    );
    const totalCandidates = Number.parseInt(countResult.rows[0]?.count ?? '0', 10);
    console.log(`Reports with legacy score/seo.contacts fields: ${totalCandidates}`);

    if (options.dryRun || totalCandidates === 0) {
      return;
    }

    let cleaned = 0;
    const maxUpdates = options.limit ?? Number.POSITIVE_INFINITY;

    while (cleaned < maxUpdates) {
      const batchLimit = Math.min(options.batchSize, maxUpdates - cleaned);
      if (batchLimit <= 0) break;

      const result = await pool.query<{ domain: string }>(
        `
        WITH targets AS (
          SELECT ctid, domain
          FROM site_profiles
          WHERE ${LEGACY_WHERE}
          LIMIT $1
        )
        UPDATE site_profiles sp
        SET report_json = CASE
          WHEN jsonb_typeof(sp.report_json->'seo') = 'object'
            THEN jsonb_set(sp.report_json - 'score', '{seo}', (sp.report_json->'seo') - 'contacts', true)
          ELSE sp.report_json - 'score'
        END
        FROM targets
        WHERE sp.ctid = targets.ctid
        RETURNING sp.domain
        `,
        [batchLimit],
      );

      const batchUpdated = result.rowCount ?? 0;
      cleaned += batchUpdated;
      console.log(`Cleaned ${cleaned} / ${Math.min(totalCandidates, maxUpdates)} reports`);

      if (batchUpdated < batchLimit) {
        break;
      }
    }
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  console.error('Cleanup failed:', error);
  process.exit(1);
});
