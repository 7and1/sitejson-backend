import { loadEnv } from '../config/env.js';
import { createPostgresPool } from '../storage/postgres.js';

interface Options {
  analyze: boolean;
  buffers: boolean;
  format: 'text' | 'json';
  limit: number;
}

const parseArgs = (): Options => {
  const options: Options = {
    analyze: false,
    buffers: false,
    format: 'text',
    limit: 100,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--analyze') {
      options.analyze = true;
      continue;
    }

    if (arg === '--buffers') {
      options.buffers = true;
      continue;
    }

    if (arg.startsWith('--format=')) {
      const value = (arg.split('=')[1] ?? '').trim().toLowerCase();
      if (value === 'json' || value === 'text') {
        options.format = value;
      }
      continue;
    }

    if (arg.startsWith('--limit=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) {
        options.limit = value;
      }
    }
  }

  return options;
};

const buildExplainSql = (options: Options): string => {
  const flags = [
    options.analyze ? 'ANALYZE true' : 'ANALYZE false',
    options.buffers ? 'BUFFERS true' : 'BUFFERS false',
    options.format === 'json' ? 'FORMAT JSON' : 'FORMAT TEXT',
  ];

  return `
    EXPLAIN (${flags.join(', ')})
    SELECT *
    FROM crawl_targets
    WHERE next_due_at <= NOW()
    ORDER BY priority DESC, updated_at ASC
    LIMIT $1
  `;
};

const run = async () => {
  const options = parseArgs();
  const env = loadEnv();

  if (env.STORAGE_DRIVER !== 'postgres' || !env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required with STORAGE_DRIVER=postgres to explain getDueBatch');
  }

  const pool = createPostgresPool(env.DATABASE_URL, {
    max: 1,
    statementTimeoutMs: env.PG_STATEMENT_TIMEOUT_MS,
    applicationName: `${env.SITEJSON_SERVICE_NAME}-explain-due-batch`,
  });

  try {
    const result = await pool.query<{ 'QUERY PLAN': unknown }>(buildExplainSql(options), [options.limit]);
    const plans = result.rows.map((row) => row['QUERY PLAN']);

    if (options.format === 'json') {
      console.log(JSON.stringify(plans, null, 2));
      return;
    }

    for (const plan of plans) {
      console.log(String(plan));
    }
  } finally {
    await pool.end();
  }
};

run().catch((error) => {
  console.error('Explain due batch failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
