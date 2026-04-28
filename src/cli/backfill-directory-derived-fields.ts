import type { Pool } from 'pg';
import type { SiteReport } from '../core/types.js';
import { calculateLegitimacyScore } from '../scoring/legitimacy.js';
import { sanitizeSiteReport } from '../services/report-merge.js';
import { createPostgresPool } from '../storage/postgres.js';
import { normalizeDirectoryList, normalizeDirectorySlug } from '../storage/directory-slug.js';

type BackfillOptions = {
  apply: boolean;
  batchSize: number;
  limit: number | null;
  domain: string | null;
  help: boolean;
};

type SiteProfileDerivedRow = {
  domain: string;
  updated_at: string;
  report_json: unknown;
  category_text: string | null;
  rank_int: number | null;
  traffic_rank_int: number | null;
  tags_search: string[] | null;
  tech_search: string[] | null;
  legitimacy_score_int: number | null;
};

type DerivedFields = {
  categoryText: string | null;
  rankInt: number | null;
  trafficRankInt: number | null;
  tagsSearch: string[];
  techSearch: string[];
  legitimacyScoreInt: number;
};

type ChangeRecord = {
  domain: string;
  fields: string[];
  next: DerivedFields;
};

const LOW_SIGNAL_ALTERNATIVE_SLUGS = new Set([
  'domain-only',
  'insufficient-data',
  'uncategorized',
  'unknown',
]);

const printHelp = () => {
  console.log(`Backfill site_profiles derived directory/search fields.

Dry-run by default:
  npm run backfill:directory-fields

Apply changes:
  npm run backfill:directory-fields -- --apply

Options:
  --apply             write changes; omitted means dry-run
  --batch=<n>         rows scanned per batch, default 500
  --limit=<n>         maximum rows to scan
  --domain=<domain>   scan one domain only
  --help              print this help
`);
};

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

const parseArgs = (): BackfillOptions => {
  const options: BackfillOptions = {
    apply: false,
    batchSize: 500,
    limit: null,
    domain: null,
    help: false,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--dry-run') {
      options.apply = false;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--batch=')) {
      options.batchSize = parsePositiveInt(arg.split('=')[1], options.batchSize);
    } else if (arg.startsWith('--limit=')) {
      options.limit = parsePositiveInt(arg.split('=')[1], 0) || null;
    } else if (arg.startsWith('--domain=')) {
      const value = arg.split('=')[1]?.trim().toLowerCase();
      options.domain = value && value.length > 0 ? value : null;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.batchSize = Math.min(options.batchSize, 5000);
  return options;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isHighSignalAlternativeSlug = (value: string): boolean => {
  const normalized = normalizeDirectorySlug(value);
  return normalized.length > 0 && !LOW_SIGNAL_ALTERNATIVE_SLUGS.has(normalized);
};

const normalizeAlternativeList = (values: string[] | undefined): string[] => {
  return normalizeDirectoryList(values).filter(isHighSignalAlternativeSlug);
};

const categoryFromReport = (report: SiteReport): string | null => {
  const category = report.taxonomy?.iabCategory;
  if (!category) {
    return null;
  }

  const normalized = normalizeDirectorySlug(category);
  if (!isHighSignalAlternativeSlug(normalized)) {
    return null;
  }

  return normalized;
};

const rankFromReport = (report: SiteReport): number | undefined => {
  const radarRank = report.radar?.globalRank;
  if (typeof radarRank === 'number' && Number.isFinite(radarRank)) {
    return radarRank;
  }

  const trafficRank = report.trafficData?.globalRank;
  if (typeof trafficRank === 'number' && Number.isFinite(trafficRank)) {
    return trafficRank;
  }

  return undefined;
};

const positiveIntegerOrNull = (value: number | undefined): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.trunc(value);
};

const trafficRankFromReport = (report: SiteReport): number | null => {
  return positiveIntegerOrNull(report.trafficData?.globalRank ?? undefined);
};

const tagsFromReport = (report: SiteReport): string[] => {
  return normalizeAlternativeList(report.taxonomy?.tags);
};

const techFromReport = (report: SiteReport): string[] => {
  return normalizeDirectoryList(report.meta?.techStackDetected);
};

const reportFromRow = (row: SiteProfileDerivedRow): SiteReport => {
  const payload = isPlainObject(row.report_json) ? row.report_json : {};
  return sanitizeSiteReport({
    ...payload,
    domain: row.domain,
    updatedAt: row.updated_at,
  } as SiteReport);
};

const deriveFields = (row: SiteProfileDerivedRow): DerivedFields => {
  const report = reportFromRow(row);

  return {
    categoryText: categoryFromReport(report),
    rankInt: positiveIntegerOrNull(rankFromReport(report)),
    trafficRankInt: trafficRankFromReport(report),
    tagsSearch: tagsFromReport(report),
    techSearch: techFromReport(report),
    legitimacyScoreInt: calculateLegitimacyScore(report).value,
  };
};

const normalizeRowArray = (value: string[] | null): string[] => (
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
);

const arraysEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
};

const diffFields = (row: SiteProfileDerivedRow, next: DerivedFields): string[] => {
  const fields: string[] = [];

  if ((row.category_text ?? null) !== next.categoryText) fields.push('category_text');
  if ((row.rank_int ?? null) !== next.rankInt) fields.push('rank_int');
  if ((row.traffic_rank_int ?? null) !== next.trafficRankInt) fields.push('traffic_rank_int');
  if (!arraysEqual(normalizeRowArray(row.tags_search), next.tagsSearch)) fields.push('tags_search');
  if (!arraysEqual(normalizeRowArray(row.tech_search), next.techSearch)) fields.push('tech_search');
  if ((row.legitimacy_score_int ?? null) !== next.legitimacyScoreInt) fields.push('legitimacy_score_int');

  return fields;
};

const loadBatch = async (
  pool: Pool,
  options: BackfillOptions,
  lastDomain: string,
  limit: number,
): Promise<SiteProfileDerivedRow[]> => {
  const params: Array<string | number> = [];
  const where: string[] = [];

  if (options.domain) {
    params.push(options.domain);
    where.push(`domain = $${params.length}`);
  }

  params.push(lastDomain);
  where.push(`domain > $${params.length}`);

  params.push(limit);
  const limitParam = `$${params.length}`;

  const result = await pool.query<SiteProfileDerivedRow>(
    `SELECT
       domain,
       updated_at::text,
       report_json,
       category_text,
       rank_int,
       traffic_rank_int,
       tags_search,
       tech_search,
       legitimacy_score_int
     FROM site_profiles
     WHERE ${where.join(' AND ')}
     ORDER BY domain ASC
     LIMIT ${limitParam}`,
    params,
  );

  return result.rows;
};

const applyChanges = async (pool: Pool, changes: ChangeRecord[]): Promise<number> => {
  if (changes.length === 0) {
    return 0;
  }

  const client = await pool.connect();
  let updated = 0;

  try {
    await client.query('BEGIN');
    for (const change of changes) {
      const result = await client.query(
        `UPDATE site_profiles
         SET
           category_text = $2,
           rank_int = $3,
           traffic_rank_int = $4,
           tags_search = $5::text[],
           tech_search = $6::text[],
           legitimacy_score_int = $7
         WHERE domain = $1`,
        [
          change.domain,
          change.next.categoryText,
          change.next.rankInt,
          change.next.trafficRankInt,
          change.next.tagsSearch,
          change.next.techSearch,
          change.next.legitimacyScoreInt,
        ],
      );
      updated += result.rowCount ?? 0;
    }
    await client.query('COMMIT');
    return updated;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const main = async () => {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    return;
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for directory derived-field backfill');
  }

  const pool = createPostgresPool(databaseUrl);
  const samples: ChangeRecord[] = [];

  let scanned = 0;
  let changed = 0;
  let updated = 0;
  let lastDomain = '';

  try {
    while (options.limit === null || scanned < options.limit) {
      const remaining = options.limit === null
        ? options.batchSize
        : Math.min(options.batchSize, options.limit - scanned);
      if (remaining <= 0) {
        break;
      }

      const rows = await loadBatch(pool, options, lastDomain, remaining);
      if (rows.length === 0) {
        break;
      }

      const changes: ChangeRecord[] = [];
      for (const row of rows) {
        const next = deriveFields(row);
        const fields = diffFields(row, next);
        if (fields.length > 0) {
          const change = { domain: row.domain, fields, next };
          changes.push(change);
          if (samples.length < 10) {
            samples.push(change);
          }
        }
      }

      scanned += rows.length;
      changed += changes.length;
      lastDomain = rows[rows.length - 1]?.domain ?? lastDomain;

      if (options.apply) {
        updated += await applyChanges(pool, changes);
      }

      console.log(
        `${options.apply ? 'Applied' : 'Scanned'} batch: scanned=${scanned} changed=${changed} updated=${updated}`,
      );

      if (rows.length < remaining || options.domain) {
        break;
      }
    }

    console.log(JSON.stringify({
      mode: options.apply ? 'apply' : 'dry-run',
      scanned,
      changed,
      updated,
      batchSize: options.batchSize,
      limit: options.limit,
      domain: options.domain,
    }, null, 2));

    if (samples.length > 0) {
      console.log(JSON.stringify({
        sampleChanges: samples.map((sample) => ({
          domain: sample.domain,
          fields: sample.fields,
          next: sample.next,
        })),
      }, null, 2));
    }
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  console.error('Backfill failed:', error);
  process.exit(1);
});
