import { loadEnv } from '../config/env.js';
import { createPostgresPool, ensurePostgresSchema, PostgresSiteRepository } from '../storage/postgres.js';

type Options = {
  apply: boolean;
  domain: string | null;
  help: boolean;
  itemsPerDomain: number;
  limit: number;
};

const printHelp = () => {
  console.log(`Backfill durable alternatives cache.

Dry-run by default; it only lists how many candidate domains would be processed:
  npm run backfill:alternatives-cache

Apply cache generation:
  npm run backfill:alternatives-cache -- --apply --limit=200

Options:
  --apply             write cache rows by calling findAlternatives()
  --domain=<domain>   process one domain
  --items=<n>         alternatives per domain, default 6, max 20
  --limit=<n>         maximum domains to process, default 100
  --help              print this help
`);
};

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseArgs = (): Options => {
  const options: Options = {
    apply: false,
    domain: null,
    help: false,
    itemsPerDomain: 6,
    limit: 100,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--dry-run') {
      options.apply = false;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--domain=')) {
      const value = arg.split('=')[1]?.trim().toLowerCase();
      options.domain = value && value.length > 0 ? value : null;
    } else if (arg.startsWith('--items=')) {
      options.itemsPerDomain = Math.min(20, parsePositiveInt(arg.split('=')[1], options.itemsPerDomain));
    } else if (arg.startsWith('--limit=')) {
      options.limit = Math.min(5000, parsePositiveInt(arg.split('=')[1], options.limit));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
};

const main = async () => {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    return;
  }

  const env = loadEnv();
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for alternatives cache backfill');
  }

  const pool = createPostgresPool(env.DATABASE_URL);
  try {
    await ensurePostgresSchema(pool);
    const domainResult = options.domain
      ? { rows: [{ domain: options.domain }] }
      : await pool.query<{ domain: string }>(
        `SELECT domain
         FROM site_profiles
         ORDER BY COALESCE(rank_int, traffic_rank_int, 999999999) ASC, updated_at DESC
         LIMIT $1`,
        [options.limit],
      );

    const domains = domainResult.rows.map((row) => row.domain);
    if (!options.apply) {
      console.log(`Dry run: ${domains.length} domain(s) selected for alternatives cache backfill.`);
      console.log('Re-run with --apply to generate cache rows.');
      return;
    }

    const repo = new PostgresSiteRepository(pool);
    let generated = 0;
    let empty = 0;
    let missing = 0;

    for (const domain of domains) {
      const result = await repo.findAlternatives(domain, options.itemsPerDomain);
      if (!result) {
        missing += 1;
        continue;
      }
      if (result.items.length === 0) {
        empty += 1;
      }
      generated += 1;
    }

    console.log(`Alternatives cache backfill complete: generated=${generated} empty=${empty} missing=${missing}.`);
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
