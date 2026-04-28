import { Pool } from 'pg';
import type {
  AlternativeSearchResult,
  CrawlJob,
  CrawlTarget,
  DirectoryItem,
  DirectorySearchOptions,
  DirectoryStats,
  DirectoryType,
  DirectoryTypeSummary,
  GlobalInsights,
  RadarSnapshot,
  SiteReport,
} from '../core/types.js';
import type {
  CrawlTargetRepository,
  CrawlTargetScheduleDue,
  CrawlTargetUpdatePatch,
  JobRepository,
  RadarSnapshotRepository,
  SiteRepository,
  TaxonomyData,
  TrafficRefreshOptions,
} from './interfaces.js';
import { sanitizeSiteReport } from '../services/report-merge.js';
import { calculateLegitimacyScore } from '../scoring/legitimacy.js';
import { normalizeDirectoryList, normalizeDirectorySlug } from './directory-slug.js';
import {
  ALTERNATIVES_CACHE_ALGORITHM_VERSION,
  computeAlternativesQualityScore,
  createAlternativesCacheExpiry,
  parseAlternativesCachePayload,
} from './alternatives-cache.js';

/** Strip \u0000 (null bytes) that PostgreSQL JSONB rejects */
const safeJsonStringify = (value: unknown): string =>
  JSON.stringify(value).replaceAll('\\u0000', '');

type DashboardStatsRow = {
  created_total: string;
  running: string;
  completed: string;
  failed: string;
  avg_e2e_seconds: string | null;
  traffic_count: string;
};

type DashboardRecentRow = {
  id: string;
  domain: string;
  status: CrawlJob['status'];
  priority: CrawlJob['priority'];
  stage: string | null;
  updated_at: string;
  error_message: string | null;
  rank: number | null;
};

type SiteProfileRow = {
  domain: string;
  updated_at: string;
  freshness_ttl_sec: number | null;
  report_json: unknown;
  total_count?: string;
  category_text?: string | null;
  rank_int?: number | null;
  traffic_rank_int?: number | null;
  tags_search?: string[] | null;
  tech_search?: string[] | null;
  legitimacy_score_int?: number | null;
};

type AlternativeCandidateRow = {
  domain: string;
  title: string;
  rank: number | null;
  traffic_rank: number | null;
  category_text: string | null;
  tags: string[] | null;
  tech: string[] | null;
};

type AlternativeCacheRow = {
  items_json: unknown;
};

type AlternativeCandidate = {
  domain: string;
  title: string;
  rank: number | null;
  trafficRank: number | null;
  categoryText: string | null;
  tags: string[];
  tech: string[];
};

type AlternativeTargetSignals = {
  category: string | null;
  rank: number | null;
  trafficRank: number | null;
  tags: string[];
  tech: string[];
};

type CrawlJobRow = {
  id: string;
  domain: string;
  status: CrawlJob['status'];
  priority: CrawlJob['priority'];
  progress: number;
  stage: string | null;
  trace_id: string;
  created_at: string;
  updated_at: string;
  error_message: string | null;
};

type RadarSnapshotRow = {
  domain: string;
  updated_at: string;
  payload_json: unknown;
};

type CrawlTargetRow = {
  domain: string;
  priority: number;
  is_high_value: boolean;
  radar_rank: number | null;
  last_browser_at: string | null;
  next_browser_at: string | null;
  last_browser_status: CrawlTarget['lastBrowserStatus'] | null;
  last_async_at: string | null;
  last_async_status: CrawlTarget['lastAsyncStatus'] | null;
  last_radar_at: string | null;
  next_radar_at: string | null;
  last_radar_status: CrawlTarget['lastRadarStatus'] | null;
  last_traffic_at: string | null;
  next_traffic_at: string | null;
  last_whois_at: string | null;
  next_whois_at: string | null;
  taxonomy_data: unknown;
  taxonomy_updated_at: string | null;
  taxonomy_model: string | null;
  taxonomy_prompt_version: number | null;
  taxonomy_last_trigger_reason: CrawlTarget['taxonomyLastTriggerReason'] | null;
  taxonomy_source_lane: CrawlTarget['taxonomySourceLane'] | null;
  last_content_hash: string | null;
  created_at: string;
  updated_at: string;
  error_count: number;
  whois_error_count: number;
};

const parseCount = (value: string | null | undefined): number => {
  const parsed = Number.parseInt(value ?? '0', 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

const parseFloatSafe = (value: string | null | undefined): number => {
  if (!value) {
    return 0;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toNullableIsoTimestamp = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};

const ALTERNATIVES_CACHE_TTL_MS = 15 * 60 * 1000;
const ALTERNATIVES_QUERY_LIMIT = 50;
const ALTERNATIVES_POOL_LIMIT = 200;
const LOW_SIGNAL_ALTERNATIVE_SLUGS = new Set([
  'domain-only',
  'insufficient-data',
  'uncategorized',
  'unknown',
]);

const isHighSignalAlternativeSlug = (value: string): boolean => {
  const normalized = normalizeSlug(value);
  return normalized.length > 0 && !LOW_SIGNAL_ALTERNATIVE_SLUGS.has(normalized);
};

const normalizeAlternativeList = (values: string[] | undefined): string[] => {
  return normalizeList(values).filter(isHighSignalAlternativeSlug);
};

const mapReportRow = (row: SiteProfileRow): SiteReport => {
  const payload = typeof row.report_json === 'object' && row.report_json ? (row.report_json as SiteReport) : ({} as SiteReport);
  return sanitizeSiteReport({
    ...payload,
    domain: row.domain,
    updatedAt: row.updated_at,
    freshnessTtlSec: row.freshness_ttl_sec ?? undefined,
  });
};

const mapJobRow = (row: CrawlJobRow): CrawlJob => {
  return {
    id: row.id,
    domain: row.domain,
    status: row.status,
    priority: row.priority,
    progress: row.progress,
    stage: row.stage ?? undefined,
    traceId: row.trace_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    errorMessage: row.error_message ?? undefined,
  };
};

const mapRadarSnapshotRow = (row: RadarSnapshotRow): RadarSnapshot => {
  const payload = typeof row.payload_json === 'object' && row.payload_json
    ? (row.payload_json as Partial<RadarSnapshot>)
    : {};

  return {
    domain: row.domain,
    globalRank: typeof payload.globalRank === 'number' ? payload.globalRank : null,
    rankBucket: payload.rankBucket,
    categories: Array.isArray(payload.categories)
      ? payload.categories.filter((item): item is string => typeof item === 'string')
      : [],
    sourceTimestamp: typeof payload.sourceTimestamp === 'string' ? payload.sourceTimestamp : row.updated_at,
    updatedAt: row.updated_at,
  };
};

const mapTaxonomyData = (value: unknown): TaxonomyData | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const payload = value as Partial<TaxonomyData>;
  if (!payload.iabCategory || !payload.iabSubCategory || !Array.isArray(payload.tags)) {
    return undefined;
  }

  return {
    iabCategory: payload.iabCategory,
    iabSubCategory: payload.iabSubCategory,
    confidence: typeof payload.confidence === 'number' ? payload.confidence : 0,
    tags: payload.tags.filter((item: unknown): item is string => typeof item === 'string'),
  };
};

const mapCrawlTargetRow = (row: CrawlTargetRow): CrawlTarget => {
  return {
    domain: row.domain,
    priority: row.priority,
    isHighValue: row.is_high_value,
    radarRank: row.radar_rank ?? undefined,
    lastBrowserAt: row.last_browser_at ?? undefined,
    nextBrowserAt: row.next_browser_at ?? undefined,
    lastBrowserStatus: row.last_browser_status ?? undefined,
    lastAsyncAt: row.last_async_at ?? undefined,
    lastAsyncStatus: row.last_async_status ?? undefined,
    lastRadarAt: row.last_radar_at ?? undefined,
    nextRadarAt: row.next_radar_at ?? undefined,
    lastRadarStatus: row.last_radar_status ?? undefined,
    lastTrafficAt: row.last_traffic_at ?? undefined,
    nextTrafficAt: row.next_traffic_at ?? undefined,
    lastWhoisAt: row.last_whois_at ?? undefined,
    nextWhoisAt: row.next_whois_at ?? undefined,
    taxonomyData: mapTaxonomyData(row.taxonomy_data),
    taxonomyUpdatedAt: row.taxonomy_updated_at ?? undefined,
    taxonomyModel: row.taxonomy_model ?? undefined,
    taxonomyPromptVersion: row.taxonomy_prompt_version ?? undefined,
    taxonomyLastTriggerReason: row.taxonomy_last_trigger_reason ?? undefined,
    taxonomySourceLane: row.taxonomy_source_lane ?? undefined,
    lastContentHash: row.last_content_hash ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    errorCount: row.error_count,
    whoisErrorCount: row.whois_error_count,
  };
};

const normalizeSlug = normalizeDirectorySlug;
const normalizeList = normalizeDirectoryList;

const categoryFromReport = (report: SiteReport): string | undefined => {
  const category = report.taxonomy?.iabCategory;
  if (!category) {
    return undefined;
  }

  const normalized = normalizeSlug(category);
  if (!isHighSignalAlternativeSlug(normalized)) {
    return undefined;
  }

  return normalized;
};

const rankForAlternatives = (report: SiteReport): number | undefined => {
  const rank = rankFromReport(report);
  if (typeof rank !== 'number' || !Number.isFinite(rank) || rank <= 0) {
    return undefined;
  }

  return Math.trunc(rank);
};

const tagsFromReport = (report: SiteReport): string[] => {
  return normalizeAlternativeList(report.taxonomy?.tags);
};

const techFromReport = (report: SiteReport): string[] => {
  return normalizeList(report.meta?.techStackDetected);
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

const trafficRankFromReport = (report: SiteReport): number | undefined => {
  const rank = report.trafficData?.globalRank;
  return typeof rank === 'number' && Number.isFinite(rank) && rank > 0
    ? Math.trunc(rank) : undefined;
};

const jaccardScore = (left: string[], right: string[]): number => {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) {
      intersection += 1;
    }
  }

  const union = leftSet.size + rightSet.size - intersection;
  return union > 0 ? intersection / union : 0;
};

const rankProximityScore = (targetRank: number, candidateRank: number): number => {
  return 1 / (1 + Math.abs(Math.log10(targetRank) - Math.log10(candidateRank)));
};

const toAlternativeItem = (
  target: AlternativeTargetSignals,
  candidate: AlternativeCandidate,
) => {
  const tagJaccard = jaccardScore(target.tags, candidate.tags);
  const techJaccard = jaccardScore(target.tech, candidate.tech);
  const catMatch = (target.category && candidate.categoryText === target.category) ? 1.0 : 0.0;

  const radarProx = (target.rank && candidate.rank && candidate.rank > 0)
    ? rankProximityScore(target.rank, candidate.rank)
    : null;

  const trafficProx = (target.trafficRank && candidate.trafficRank && candidate.trafficRank > 0)
    ? rankProximityScore(target.trafficRank, candidate.trafficRank)
    : null;

  let rankComponent: number;
  if (radarProx !== null && trafficProx !== null) {
    rankComponent = 0.20 * radarProx + 0.20 * trafficProx;
  } else if (radarProx !== null) {
    rankComponent = 0.40 * radarProx;
  } else if (trafficProx !== null) {
    rankComponent = 0.40 * trafficProx;
  } else {
    rankComponent = 0.25 * tagJaccard;
  }

  const score = 0.20 * catMatch + 0.25 * tagJaccard + rankComponent + 0.15 * techJaccard;

  const reasons: string[] = [];
  if (catMatch > 0) reasons.push('same_category');
  if (radarProx !== null) reasons.push('similar_rank_band');
  if (trafficProx !== null) reasons.push('similar_traffic_rank');
  if (tagJaccard > 0) reasons.push('high_tag_overlap');
  if (techJaccard > 0) reasons.push('shared_tech_stack');

  return {
    domain: candidate.domain,
    title: candidate.title,
    rank: candidate.rank ?? 0,
    score: Number.parseFloat(score.toFixed(6)),
    reasons,
  };
};

const matchesDirectory = (report: SiteReport, type: DirectoryType, slug: string): boolean => {
  const normalizedSlug = normalizeSlug(slug);

  if (type === 'category') {
    return normalizeSlug(report.taxonomy?.iabCategory ?? '') === normalizedSlug;
  }

  if (type === 'technology') {
    return (report.meta?.techStackDetected ?? []).some((tech) => normalizeSlug(tech) === normalizedSlug);
  }

  return (report.taxonomy?.tags ?? []).some((tag) => normalizeSlug(tag) === normalizedSlug);
};

const toDirectoryItem = (report: SiteReport): DirectoryItem => {
  const rank = rankFromReport(report);
  const tags = report.taxonomy?.tags?.slice(0, 5);
  const techStack = report.meta?.techStackDetected?.slice(0, 5);

  return {
    domain: report.domain,
    title: report.meta?.title ?? report.domain,
    rank,
    description: report.meta?.description,
    screenshotUrl: report.visual?.screenshotUrl,
    tags: tags && tags.length > 0 ? tags : undefined,
    techStack: techStack && techStack.length > 0 ? techStack : undefined,
    monthlyVisits: report.trafficData?.monthlyVisits,
    legitimacyScore: calculateLegitimacyScore(report).value,
  };
};

const compareDirectoryItems = (left: DirectoryItem, right: DirectoryItem): number => {
  if (typeof left.rank === 'number' && typeof right.rank === 'number') {
    return left.rank - right.rank;
  }

  if (typeof left.rank === 'number') {
    return -1;
  }

  if (typeof right.rank === 'number') {
    return 1;
  }

  return left.domain.localeCompare(right.domain);
};

const DEFAULT_BROWSER_TTL_SEC = 365 * 24 * 3600; // 1 year — browser crawl is one-time
const DEFAULT_RADAR_TTL_SEC = 7 * 24 * 3600;
const DEFAULT_ASYNC_TTL_SEC = 30 * 24 * 3600;

export class PostgresSiteRepository implements SiteRepository {
  private readonly alternativesCache = new Map<string, { result: AlternativeSearchResult; expiresAt: number }>();

  constructor(private readonly pool: Pool) {}

  private getAlternativesCacheKey(domain: string, limit: number, updatedAt: string): string {
    return `${domain}:${limit}:${updatedAt}`;
  }

  private pruneExpiredAlternativesCache(now: number): void {
    for (const [key, value] of this.alternativesCache.entries()) {
      if (value.expiresAt <= now) {
        this.alternativesCache.delete(key);
      }
    }
  }

  private invalidateAlternativesCache(domain: string): void {
    const prefix = `${domain}:`;
    for (const key of this.alternativesCache.keys()) {
      if (key.startsWith(prefix)) {
        this.alternativesCache.delete(key);
      }
    }
  }

  private async loadAlternativeCandidates(
    query: string,
    params: Array<string | number | null | string[]>,
  ): Promise<AlternativeCandidate[]> {
    const result = await this.pool.query<AlternativeCandidateRow>(query, params);

    return result.rows.map((row) => ({
      domain: row.domain,
      title: row.title,
      rank: row.rank,
      trafficRank: row.traffic_rank,
      categoryText: row.category_text,
      tags: Array.isArray(row.tags) ? row.tags : [],
      tech: Array.isArray(row.tech) ? row.tech : [],
    }));
  }

  private async readDurableAlternativesCache(
    domain: string,
    limit: number,
    sourceUpdatedAt: string | null,
  ): Promise<AlternativeSearchResult | null> {
    try {
      const result = await this.pool.query<AlternativeCacheRow>(
        `SELECT items_json
         FROM site_alternatives_cache
         WHERE domain = $1
           AND algorithm_version = $2
           AND source_report_updated_at IS NOT DISTINCT FROM $3::timestamptz
           AND expires_at > NOW()
         LIMIT 1`,
        [domain, ALTERNATIVES_CACHE_ALGORITHM_VERSION, sourceUpdatedAt],
      );

      if (result.rowCount === 0) {
        return null;
      }

      return parseAlternativesCachePayload(result.rows[0].items_json, limit);
    } catch {
      return null;
    }
  }

  private async writeDurableAlternativesCache(
    domain: string,
    result: AlternativeSearchResult,
    sourceUpdatedAt: string | null,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO site_alternatives_cache (
           domain,
           algorithm_version,
           source_report_updated_at,
           items_json,
           quality_score,
           generated_at,
           expires_at
         )
         VALUES ($1, $2, $3::timestamptz, $4::jsonb, $5, NOW(), $6::timestamptz)
         ON CONFLICT (domain)
         DO UPDATE SET
           algorithm_version = EXCLUDED.algorithm_version,
           source_report_updated_at = EXCLUDED.source_report_updated_at,
           items_json = EXCLUDED.items_json,
           quality_score = EXCLUDED.quality_score,
           generated_at = EXCLUDED.generated_at,
           expires_at = EXCLUDED.expires_at`,
        [
          domain,
          ALTERNATIVES_CACHE_ALGORITHM_VERSION,
          sourceUpdatedAt,
          safeJsonStringify(result.items),
          computeAlternativesQualityScore(result),
          createAlternativesCacheExpiry(),
        ],
      );
    } catch {
      // The API path should stay available even when the durable cache is missing
      // or temporarily unavailable.
    }
  }

  async getByDomain(domain: string): Promise<SiteReport | null> {
    const result = await this.pool.query<SiteProfileRow>(
      `SELECT domain, updated_at, freshness_ttl_sec, report_json
       FROM site_profiles
       WHERE domain = $1
       LIMIT 1`,
      [domain],
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapReportRow(result.rows[0]);
  }

  async upsert(report: SiteReport): Promise<void> {
    const sanitizedReport = sanitizeSiteReport(report);
    const category = categoryFromReport(sanitizedReport) ?? null;
    const rank = rankForAlternatives(sanitizedReport) ?? null;
    const trafficRank = trafficRankFromReport(sanitizedReport) ?? null;
    const tags = tagsFromReport(sanitizedReport);
    const tech = techFromReport(sanitizedReport);
    const legitimacyScore = calculateLegitimacyScore(sanitizedReport).value;

    await this.pool.query(
      `INSERT INTO site_profiles (
         domain,
         updated_at,
         freshness_ttl_sec,
         report_json,
         category_text,
         rank_int,
         traffic_rank_int,
         tags_search,
         tech_search,
         legitimacy_score_int
       )
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::text[], $9::text[], $10)
       ON CONFLICT (domain)
       DO UPDATE SET
         updated_at = EXCLUDED.updated_at,
         freshness_ttl_sec = EXCLUDED.freshness_ttl_sec,
         report_json = EXCLUDED.report_json,
         category_text = EXCLUDED.category_text,
         rank_int = EXCLUDED.rank_int,
         traffic_rank_int = EXCLUDED.traffic_rank_int,
         tags_search = EXCLUDED.tags_search,
         tech_search = EXCLUDED.tech_search,
         legitimacy_score_int = EXCLUDED.legitimacy_score_int`,
      [
        sanitizedReport.domain,
        sanitizedReport.updatedAt,
        sanitizedReport.freshnessTtlSec ?? null,
        safeJsonStringify(sanitizedReport),
        category,
        rank,
        trafficRank,
        tags,
        tech,
        legitimacyScore,
      ],
    );

    this.invalidateAlternativesCache(sanitizedReport.domain);
  }

  private buildDirectoryBaseWhere(type: DirectoryType, slug: string): { condition: string; params: (string | number | null)[] } {
    const knownCategories: Record<string, string> = {
      'technology': 'Technology & Computing',
      'technology-and-computing': 'Technology & Computing',
      'technologycomputing': 'Technology & Computing',
      'business': 'Business and Finance',
      'business-and-finance': 'Business and Finance',
      'entertainment': 'Entertainment',
      'news': 'News and Politics',
      'news-and-politics': 'News and Politics',
      'shopping': 'Shopping',
      'travel': 'Travel',
      'sports': 'Sports',
      'health': 'Healthy Living',
      'healthy-living': 'Healthy Living',
      'education': 'Education',
    };

    const normalizedSlug = normalizeSlug(slug);
    const normalizedKey = normalizedSlug.toLowerCase();

    if (type === 'category') {
      const categoryFilter = knownCategories[normalizedKey]
        ? normalizeSlug(knownCategories[normalizedKey])
        : normalizedSlug;
      return { condition: 'category_text = $1', params: [categoryFilter] };
    } else if (type === 'technology') {
      return { condition: 'tech_search && ARRAY[$1]::text[]', params: [normalizedSlug] };
    } else {
      return { condition: 'tags_search && ARRAY[$1]::text[]', params: [normalizedSlug] };
    }
  }

  async searchDirectory(type: DirectoryType, slug: string, page: number, pageSize: number, options?: DirectorySearchOptions) {
    const safePage = Math.max(1, page);
    const safePageSize = Math.max(1, Math.min(100, pageSize));
    const offset = (safePage - 1) * safePageSize;

    const base = this.buildDirectoryBaseWhere(type, slug);
    const params: (string | number | null)[] = [...base.params];
    const extraConditions: string[] = [];

    if (options?.minScore !== undefined && Number.isFinite(options.minScore)) {
      params.push(Math.trunc(options.minScore));
      extraConditions.push(`legitimacy_score_int >= $${params.length}`);
    }

    if (options?.hasTraffic) {
      extraConditions.push('traffic_rank_int IS NOT NULL');
    }

    const whereClause = `WHERE ${base.condition}${extraConditions.length > 0 ? ' AND ' + extraConditions.join(' AND ') : ''}`;

    const sortMap: Record<string, string> = {
      rank: 'COALESCE(rank_int, 999999999) ASC',
      traffic: 'COALESCE(traffic_rank_int, 999999999) ASC',
      score: 'COALESCE(legitimacy_score_int, 0) DESC',
    };
    const orderBy = options?.sort ? (sortMap[options.sort] ?? sortMap.rank) : 'COALESCE(rank_int, traffic_rank_int, 999999999) ASC';

    const result = await this.pool.query<SiteProfileRow>(
      `SELECT
         domain,
         updated_at,
         freshness_ttl_sec,
         report_json,
         COUNT(*) OVER()::text AS total_count
       FROM site_profiles
       ${whereClause}
       ORDER BY ${orderBy}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, safePageSize, offset],
    );

    const total = parseCount(result.rows[0]?.total_count);

    const items = result.rows
      .map((row) => mapReportRow(row))
      .map((report) => toDirectoryItem(report));

    return { items, total };
  }

  async getDirectoryStats(type: DirectoryType, slug: string): Promise<DirectoryStats> {
    const base = this.buildDirectoryBaseWhere(type, slug);

    type StatsRow = {
      stats: {
        total: string;
        avg_score: string | null;
        top10k: string;
        top100k: string;
        top1m: string;
        unranked: string;
        has_traffic: string;
      };
      top_tech: Array<{ name: string; count: string }> | null;
      top_tags: Array<{ name: string; count: string }> | null;
      top_countries: Array<{ country: string; count: string }> | null;
    };

    const result = await this.pool.query<StatsRow>(
      `WITH filtered AS (
         SELECT
           rank_int,
           traffic_rank_int,
           tags_search,
           tech_search,
           legitimacy_score_int,
           report_json->'trafficData'->>'topCountry' AS top_country
         FROM site_profiles
         WHERE ${base.condition}
       ),
       base_stats AS (
         SELECT
           COUNT(*) AS total,
           AVG(legitimacy_score_int::numeric) AS avg_score,
           COUNT(*) FILTER (WHERE rank_int IS NOT NULL AND rank_int <= 10000) AS top10k,
           COUNT(*) FILTER (WHERE rank_int IS NOT NULL AND rank_int > 10000 AND rank_int <= 100000) AS top100k,
           COUNT(*) FILTER (WHERE rank_int IS NOT NULL AND rank_int > 100000 AND rank_int <= 1000000) AS top1m,
           COUNT(*) FILTER (WHERE rank_int IS NULL OR rank_int > 1000000) AS unranked,
           COUNT(*) FILTER (WHERE traffic_rank_int IS NOT NULL) AS has_traffic
         FROM filtered
       ),
       top_tech AS (
         SELECT t AS name, COUNT(*)::text AS count
         FROM filtered, unnest(tech_search) t
         WHERE t <> ''
         GROUP BY t
         ORDER BY COUNT(*) DESC
         LIMIT 10
       ),
       top_tags AS (
         SELECT t AS name, COUNT(*)::text AS count
         FROM filtered, unnest(tags_search) t
         WHERE t <> ''
         GROUP BY t
         ORDER BY COUNT(*) DESC
         LIMIT 10
       ),
       top_countries AS (
         SELECT top_country AS country, COUNT(*)::text AS count
         FROM filtered
         WHERE top_country IS NOT NULL AND top_country <> ''
         GROUP BY top_country
         ORDER BY COUNT(*) DESC
         LIMIT 10
       )
       SELECT
         row_to_json(base_stats) AS stats,
         COALESCE((SELECT json_agg(top_tech) FROM top_tech), '[]'::json) AS top_tech,
         COALESCE((SELECT json_agg(top_tags) FROM top_tags), '[]'::json) AS top_tags,
         COALESCE((SELECT json_agg(top_countries) FROM top_countries), '[]'::json) AS top_countries
       FROM base_stats`,
      base.params,
    );

    const row = result.rows[0];
    if (!row) {
      return {
        type,
        slug,
        total: 0,
        avgLegitimacyScore: null,
        trafficDistribution: { top10k: 0, top100k: 0, top1m: 0, unranked: 0 },
        topTechnologies: [],
        topTags: [],
        topCountries: [],
        hasTrafficData: 0,
      };
    }

    const s = row.stats;
    const avgRaw = s?.avg_score ? parseFloatSafe(String(s.avg_score)) : null;

    return {
      type,
      slug,
      total: parseCount(s?.total),
      avgLegitimacyScore: avgRaw !== null && Number.isFinite(avgRaw) ? Math.round(avgRaw) : null,
      trafficDistribution: {
        top10k: parseCount(s?.top10k),
        top100k: parseCount(s?.top100k),
        top1m: parseCount(s?.top1m),
        unranked: parseCount(s?.unranked),
      },
      topTechnologies: Array.isArray(row.top_tech)
        ? row.top_tech.map((r) => ({ name: r.name, count: parseCount(r.count) }))
        : [],
      topTags: Array.isArray(row.top_tags)
        ? row.top_tags.map((r) => ({ name: r.name, count: parseCount(r.count) }))
        : [],
      topCountries: Array.isArray(row.top_countries)
        ? row.top_countries.map((r) => ({ country: r.country, count: parseCount(r.count) }))
        : [],
      hasTrafficData: parseCount(s?.has_traffic),
    };
  }

  async getDirectoryTypeSummary(type: DirectoryType, limit = 50): Promise<DirectoryTypeSummary> {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));

    type SlugCountRow = { slug: string; count: string; top_domain: string | null; top_title: string | null };

    let sql: string;
    if (type === 'category') {
      sql = `
        WITH slug_counts AS (
          SELECT category_text AS slug, COUNT(*) AS count
          FROM site_profiles
          WHERE category_text IS NOT NULL AND category_text <> ''
          GROUP BY category_text
          ORDER BY COUNT(*) DESC
          LIMIT $1
        ),
        top_domains AS (
          SELECT DISTINCT ON (category_text)
            category_text AS slug,
            domain,
            COALESCE(report_json->'meta'->>'title', domain) AS title
          FROM site_profiles
          WHERE category_text IN (SELECT slug FROM slug_counts)
          ORDER BY category_text, COALESCE(rank_int, traffic_rank_int, 999999999) ASC
        )
        SELECT sc.slug, sc.count::text, td.domain AS top_domain, td.title AS top_title
        FROM slug_counts sc
        LEFT JOIN top_domains td ON td.slug = sc.slug
        ORDER BY sc.count DESC`;
    } else if (type === 'technology') {
      sql = `
        WITH slug_counts AS (
          SELECT t AS slug, COUNT(*) AS count
          FROM site_profiles, unnest(tech_search) t
          WHERE t <> ''
          GROUP BY t
          ORDER BY COUNT(*) DESC
          LIMIT $1
        ),
        top_domains AS (
          SELECT DISTINCT ON (t)
            t AS slug,
            domain,
            COALESCE(report_json->'meta'->>'title', domain) AS title
          FROM site_profiles, unnest(tech_search) t
          WHERE t IN (SELECT slug FROM slug_counts)
          ORDER BY t, COALESCE(rank_int, traffic_rank_int, 999999999) ASC
        )
        SELECT sc.slug, sc.count::text, td.domain AS top_domain, td.title AS top_title
        FROM slug_counts sc
        LEFT JOIN top_domains td ON td.slug = sc.slug
        ORDER BY sc.count DESC`;
    } else {
      sql = `
        WITH slug_counts AS (
          SELECT t AS slug, COUNT(*) AS count
          FROM site_profiles, unnest(tags_search) t
          WHERE t <> ''
          GROUP BY t
          ORDER BY COUNT(*) DESC
          LIMIT $1
        ),
        top_domains AS (
          SELECT DISTINCT ON (t)
            t AS slug,
            domain,
            COALESCE(report_json->'meta'->>'title', domain) AS title
          FROM site_profiles, unnest(tags_search) t
          WHERE t IN (SELECT slug FROM slug_counts)
          ORDER BY t, COALESCE(rank_int, traffic_rank_int, 999999999) ASC
        )
        SELECT sc.slug, sc.count::text, td.domain AS top_domain, td.title AS top_title
        FROM slug_counts sc
        LEFT JOIN top_domains td ON td.slug = sc.slug
        ORDER BY sc.count DESC`;
    }

    const result = await this.pool.query<SlugCountRow>(sql, [safeLimit]);

    const slugs = result.rows.map((row) => ({
      slug: row.slug,
      count: parseCount(row.count),
      topDomain: row.top_domain ?? undefined,
      topTitle: row.top_title ?? undefined,
    }));

    const totalSites = slugs.reduce((sum, s) => sum + s.count, 0);

    return {
      type,
      totalSlugs: slugs.length,
      totalSites,
      slugs,
    };
  }

  private insightsCache: { data: GlobalInsights; expiresAt: number } | null = null;

  async getGlobalInsights(): Promise<GlobalInsights> {
    const now = Date.now();
    if (this.insightsCache && now < this.insightsCache.expiresAt) {
      return this.insightsCache.data;
    }

    type InsightsRow = {
      total_sites: string;
      with_traffic: string;
      with_score: string;
      score_high: string;
      score_medium: string;
      score_low: string;
      score_unscored: string;
      top_categories: Array<{ slug: string; count: string }> | null;
      top_technologies: Array<{ name: string; count: string }> | null;
      top_topics: Array<{ name: string; count: string }> | null;
    };

    const result = await this.pool.query<InsightsRow>(`
      WITH base AS (
        SELECT
          COUNT(*) AS total_sites,
          COUNT(*) FILTER (WHERE traffic_rank_int IS NOT NULL) AS with_traffic,
          COUNT(*) FILTER (WHERE legitimacy_score_int IS NOT NULL) AS with_score,
          COUNT(*) FILTER (WHERE legitimacy_score_int >= 70) AS score_high,
          COUNT(*) FILTER (WHERE legitimacy_score_int >= 40 AND legitimacy_score_int < 70) AS score_medium,
          COUNT(*) FILTER (WHERE legitimacy_score_int < 40 AND legitimacy_score_int IS NOT NULL) AS score_low,
          COUNT(*) FILTER (WHERE legitimacy_score_int IS NULL) AS score_unscored
        FROM site_profiles
      ),
      top_categories AS (
        SELECT category_text AS slug, COUNT(*)::text AS count
        FROM site_profiles
        WHERE category_text IS NOT NULL AND category_text <> ''
        GROUP BY category_text
        ORDER BY COUNT(*) DESC
        LIMIT 10
      ),
      top_technologies AS (
        SELECT t AS name, COUNT(*)::text AS count
        FROM site_profiles, unnest(tech_search) t
        WHERE t <> ''
        GROUP BY t
        ORDER BY COUNT(*) DESC
        LIMIT 10
      ),
      top_topics AS (
        SELECT t AS name, COUNT(*)::text AS count
        FROM site_profiles, unnest(tags_search) t
        WHERE t <> ''
        GROUP BY t
        ORDER BY COUNT(*) DESC
        LIMIT 10
      )
      SELECT
        b.total_sites::text,
        b.with_traffic::text,
        b.with_score::text,
        b.score_high::text,
        b.score_medium::text,
        b.score_low::text,
        b.score_unscored::text,
        COALESCE((SELECT json_agg(top_categories) FROM top_categories), '[]'::json) AS top_categories,
        COALESCE((SELECT json_agg(top_technologies) FROM top_technologies), '[]'::json) AS top_technologies,
        COALESCE((SELECT json_agg(top_topics) FROM top_topics), '[]'::json) AS top_topics
      FROM base b`);

    const row = result.rows[0];
    const insights: GlobalInsights = {
      totalSites: parseCount(row?.total_sites),
      withTraffic: parseCount(row?.with_traffic),
      withScore: parseCount(row?.with_score),
      scoreDistribution: {
        high: parseCount(row?.score_high),
        medium: parseCount(row?.score_medium),
        low: parseCount(row?.score_low),
        unscored: parseCount(row?.score_unscored),
      },
      topCategories: Array.isArray(row?.top_categories)
        ? row.top_categories.map((r) => ({ slug: r.slug, count: parseCount(r.count) }))
        : [],
      topTechnologies: Array.isArray(row?.top_technologies)
        ? row.top_technologies.map((r) => ({ name: r.name, count: parseCount(r.count) }))
        : [],
      topTopics: Array.isArray(row?.top_topics)
        ? row.top_topics.map((r) => ({ name: r.name, count: parseCount(r.count) }))
        : [],
    };

    this.insightsCache = { data: insights, expiresAt: now + 3600_000 };
    return insights;
  }

  async findAlternatives(domain: string, limit: number): Promise<AlternativeSearchResult | null> {
    const target = await this.getByDomain(domain);
    if (!target) {
      return null;
    }

    const safeLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
    const targetSignals: AlternativeTargetSignals = {
      category: categoryFromReport(target) ?? null,
      rank: rankForAlternatives(target) ?? null,
      trafficRank: trafficRankFromReport(target) ?? null,
      tags: tagsFromReport(target),
      tech: techFromReport(target),
    };

    const cacheKey = this.getAlternativesCacheKey(target.domain, safeLimit, target.updatedAt);
    const now = Date.now();
    this.pruneExpiredAlternativesCache(now);
    const cached = this.alternativesCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.result;
    }

    const sourceUpdatedAt = toNullableIsoTimestamp(target.updatedAt);
    const durableCached = await this.readDurableAlternativesCache(target.domain, safeLimit, sourceUpdatedAt);
    if (durableCached) {
      this.alternativesCache.set(cacheKey, {
        result: durableCached,
        expiresAt: now + ALTERNATIVES_CACHE_TTL_MS,
      });
      return durableCached;
    }

    // Need at least one signal to find alternatives
    if (!targetSignals.category && targetSignals.tags.length === 0 && !targetSignals.rank && !targetSignals.trafficRank) {
      const emptyResult: AlternativeSearchResult = {
        items: [],
        algorithm: 'rule_based',
      };
      this.alternativesCache.set(cacheKey, {
        result: emptyResult,
        expiresAt: now + ALTERNATIVES_CACHE_TTL_MS,
      });
      await this.writeDurableAlternativesCache(target.domain, emptyResult, sourceUpdatedAt);
      return emptyResult;
    }

    // Rank band boundaries (0.1x – 10x) for whichever rank is available
    const minRadarRank = targetSignals.rank ? Math.max(1, Math.floor(targetSignals.rank * 0.1)) : null;
    const maxRadarRank = targetSignals.rank ? Math.ceil(targetSignals.rank * 10) : null;
    const minTrafficRank = targetSignals.trafficRank ? Math.max(1, Math.floor(targetSignals.trafficRank * 0.1)) : null;
    const maxTrafficRank = targetSignals.trafficRank ? Math.ceil(targetSignals.trafficRank * 10) : null;

    const mergedCandidates = new Map<string, AlternativeCandidate>();
    const mergeCandidates = (candidates: AlternativeCandidate[]) => {
      for (const candidate of candidates) {
        if (candidate.domain === target.domain || mergedCandidates.has(candidate.domain)) {
          continue;
        }
        mergedCandidates.set(candidate.domain, candidate);
        if (mergedCandidates.size >= ALTERNATIVES_POOL_LIMIT) {
          return;
        }
      }
    };

    const candidateSelect = `SELECT
       domain,
       COALESCE(report_json->'meta'->>'title', domain) AS title,
       rank_int AS rank,
       traffic_rank_int AS traffic_rank,
       category_text,
       COALESCE(tags_search, ARRAY[]::text[]) AS tags,
       COALESCE(tech_search, ARRAY[]::text[]) AS tech
     FROM site_profiles
     WHERE domain <> $1`;
    const targetPoolSize = Math.min(ALTERNATIVES_POOL_LIMIT, Math.max(safeLimit * 8, ALTERNATIVES_QUERY_LIMIT));
    const queryPlans: Array<{ query: string; params: Array<string | number | null | string[]> }> = [];

    if (targetSignals.category) {
      queryPlans.push({
        query: `${candidateSelect}
          AND category_text = $2
        ORDER BY rank_int ASC NULLS LAST, traffic_rank_int ASC NULLS LAST
        LIMIT $3`,
        params: [target.domain, targetSignals.category, ALTERNATIVES_QUERY_LIMIT],
      });
    }

    if (minRadarRank !== null && maxRadarRank !== null) {
      queryPlans.push({
        query: `${candidateSelect}
          AND rank_int BETWEEN $2 AND $3
        ORDER BY rank_int ASC
        LIMIT $4`,
        params: [target.domain, minRadarRank, maxRadarRank, ALTERNATIVES_QUERY_LIMIT],
      });
    }

    if (targetSignals.tags.length > 0) {
      queryPlans.push({
        query: `${candidateSelect}
          AND tags_search && $2::text[]
        LIMIT $3`,
        params: [target.domain, targetSignals.tags, ALTERNATIVES_QUERY_LIMIT],
      });
    }

    if (targetSignals.tech.length > 0) {
      queryPlans.push({
        query: `${candidateSelect}
          AND tech_search && $2::text[]
        LIMIT $3`,
        params: [target.domain, targetSignals.tech, ALTERNATIVES_QUERY_LIMIT],
      });
    }

    if (minTrafficRank !== null && maxTrafficRank !== null) {
      queryPlans.push({
        query: `${candidateSelect}
          AND traffic_rank_int BETWEEN $2 AND $3
        ORDER BY traffic_rank_int ASC
        LIMIT $4`,
        params: [target.domain, minTrafficRank, maxTrafficRank, ALTERNATIVES_QUERY_LIMIT],
      });
    }

    for (const plan of queryPlans) {
      mergeCandidates(await this.loadAlternativeCandidates(plan.query, plan.params));
      if (mergedCandidates.size >= targetPoolSize) {
        break;
      }
    }

    const alternativesResult: AlternativeSearchResult = {
      algorithm: 'rule_based',
      items: Array.from(mergedCandidates.values())
        .map((candidate) => toAlternativeItem(targetSignals, candidate))
        .sort((left, right) => {
          if (right.score !== left.score) {
            return right.score - left.score;
          }
          return (left.rank || 999999999) - (right.rank || 999999999);
        })
        .slice(0, safeLimit),
    };

    this.alternativesCache.set(cacheKey, {
      result: alternativesResult,
      expiresAt: now + ALTERNATIVES_CACHE_TTL_MS,
    });
    await this.writeDurableAlternativesCache(target.domain, alternativesResult, sourceUpdatedAt);

    return alternativesResult;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}

export class PostgresRadarSnapshotRepository implements RadarSnapshotRepository {
  constructor(private readonly pool: Pool) {}

  async getByDomain(domain: string): Promise<RadarSnapshot | null> {
    const result = await this.pool.query<RadarSnapshotRow>(
      `SELECT domain, updated_at, payload_json
       FROM radar_snapshots
       WHERE domain = $1
       LIMIT 1`,
      [domain],
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapRadarSnapshotRow(result.rows[0]);
  }

  async upsert(snapshot: RadarSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO radar_snapshots (domain, updated_at, payload_json)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (domain)
       DO UPDATE SET
         updated_at = EXCLUDED.updated_at,
         payload_json = EXCLUDED.payload_json`,
      [snapshot.domain, snapshot.updatedAt, safeJsonStringify(snapshot)],
    );
  }

  async bulkUpsert(snapshots: RadarSnapshot[]): Promise<void> {
    if (snapshots.length === 0) {
      return;
    }

    const domains = snapshots.map((snapshot) => snapshot.domain);
    const updatedAts = snapshots.map((snapshot) => snapshot.updatedAt);
    const payloads = snapshots.map((snapshot) => safeJsonStringify(snapshot));

    await this.pool.query(
      `INSERT INTO radar_snapshots (domain, updated_at, payload_json)
       SELECT data.domain, data.updated_at, data.payload_json::jsonb
       FROM UNNEST($1::text[], $2::timestamptz[], $3::text[]) AS data(domain, updated_at, payload_json)
       ON CONFLICT (domain)
       DO UPDATE SET
         updated_at = EXCLUDED.updated_at,
         payload_json = EXCLUDED.payload_json`,
      [domains, updatedAts, payloads],
    );
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1 FROM radar_snapshots LIMIT 1');
      return true;
    } catch {
      return false;
    }
  }
}

export class PostgresJobRepository implements JobRepository {
  constructor(private readonly pool: Pool) {}

  async create(job: CrawlJob): Promise<void> {
    await this.pool.query(
      `INSERT INTO crawl_jobs (
         id, domain, status, priority, progress, stage,
         trace_id, created_at, updated_at, error_message
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        job.id,
        job.domain,
        job.status,
        job.priority,
        job.progress,
        job.stage ?? null,
        job.traceId,
        job.createdAt,
        job.updatedAt,
        job.errorMessage ?? null,
      ],
    );
  }

  async createPendingIfAbsent(job: CrawlJob): Promise<{ created: boolean; existingJobId?: string }> {
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO crawl_jobs (
         id, domain, status, priority, progress, stage,
         trace_id, created_at, updated_at, error_message
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        job.id,
        job.domain,
        job.status,
        job.priority,
        job.progress,
        job.stage ?? null,
        job.traceId,
        job.createdAt,
        job.updatedAt,
        job.errorMessage ?? null,
      ],
    );

    if ((inserted.rowCount ?? 0) > 0) {
      return { created: true };
    }

    const existing = await this.pool.query<{ id: string }>(
      `SELECT id
       FROM crawl_jobs
       WHERE domain = $1
         AND status IN ('pending', 'running')
       ORDER BY created_at DESC
       LIMIT 1`,
      [job.domain],
    );

    if (existing.rowCount === 0) {
      return { created: false };
    }

    return {
      created: false,
      existingJobId: existing.rows[0].id,
    };
  }

  async getById(id: string): Promise<CrawlJob | null> {
    const result = await this.pool.query<CrawlJobRow>(
      `SELECT id, domain, status, priority, progress, stage,
              trace_id, created_at, updated_at, error_message
       FROM crawl_jobs
       WHERE id = $1
       LIMIT 1`,
      [id],
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapJobRow(result.rows[0]);
  }

  async update(job: CrawlJob): Promise<void> {
    await this.pool.query(
      `UPDATE crawl_jobs
       SET status = $2,
           priority = $3,
           progress = $4,
           stage = $5,
           trace_id = $6,
           created_at = $7,
           updated_at = $8,
           error_message = $9
       WHERE id = $1`,
      [
        job.id,
        job.status,
        job.priority,
        job.progress,
        job.stage ?? null,
        job.traceId,
        job.createdAt,
        job.updatedAt,
        job.errorMessage ?? null,
      ],
    );
  }

  async markRunning(jobId: string, stage: string, progress?: number): Promise<void> {
    const progressValue = typeof progress === 'number' && Number.isFinite(progress)
      ? Math.max(0, Math.min(100, Math.trunc(progress)))
      : null;

    await this.pool.query(
      `UPDATE crawl_jobs
       SET status = 'running',
           stage = $2,
           progress = COALESCE($3, progress),
           updated_at = NOW(),
           error_message = NULL
       WHERE id = $1
         AND status IN ('pending', 'running')`,
      [jobId, stage, progressValue],
    );
  }

  async markCompleted(jobId: string, stage = 'done', progress = 100): Promise<void> {
    const progressValue = Math.max(0, Math.min(100, Math.trunc(progress)));

    await this.pool.query(
      `UPDATE crawl_jobs
       SET status = 'completed',
           stage = $2,
           progress = $3,
           updated_at = NOW()
       WHERE id = $1
         AND status IN ('pending', 'running')`,
      [jobId, stage, progressValue],
    );
  }

  async markFailed(jobId: string, errorMessage: string, stage = 'failed'): Promise<void> {
    await this.pool.query(
      `UPDATE crawl_jobs
       SET status = 'failed',
           stage = $2,
           error_message = $3,
           updated_at = NOW()
       WHERE id = $1
         AND status IN ('pending', 'running')`,
      [jobId, stage, errorMessage],
    );
  }

  async findRunningByDomain(domain: string): Promise<CrawlJob | null> {
    const result = await this.pool.query<CrawlJobRow>(
      `SELECT id, domain, status, priority, progress, stage,
              trace_id, created_at, updated_at, error_message
       FROM crawl_jobs
       WHERE domain = $1
         AND status IN ('pending', 'running')
       ORDER BY created_at DESC
       LIMIT 1`,
      [domain],
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapJobRow(result.rows[0]);
  }

  async getDashboardJobStats(windowMs: number) {
    const windowSeconds = Math.max(1, Math.floor(windowMs / 1000));
    const result = await this.pool.query<DashboardStatsRow>(
      `WITH window_jobs AS (
         SELECT id, domain, status, created_at, updated_at
         FROM crawl_jobs
         WHERE updated_at >= NOW() - make_interval(secs => $1)
       ),
       traffic_rows AS (
         SELECT
           CASE
             WHEN (sp.report_json->'trafficData'->>'monthlyVisits') IS NOT NULL THEN 1
             ELSE 0
           END AS has_traffic
         FROM window_jobs wj
         JOIN site_profiles sp ON sp.domain = wj.domain
         WHERE wj.status = 'completed'
       )
       SELECT
         COUNT(*)::text AS created_total,
         COUNT(*) FILTER (WHERE status = 'running')::text AS running,
         COUNT(*) FILTER (WHERE status = 'completed')::text AS completed,
         COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
         AVG(
           CASE
             WHEN status = 'completed' THEN EXTRACT(EPOCH FROM (updated_at - created_at))
             ELSE NULL
           END
         )::text AS avg_e2e_seconds,
         COALESCE((SELECT COUNT(*)::text FROM traffic_rows WHERE has_traffic = 1), '0') AS traffic_count
       FROM window_jobs`,
      [windowSeconds],
    );

    const row = result.rows[0];
    const createdTotal = parseCount(row?.created_total);
    const completed = parseCount(row?.completed);
    const trafficCount = parseCount(row?.traffic_count);

    return {
      createdTotal,
      running: parseCount(row?.running),
      completed,
      failed: parseCount(row?.failed),
      successRate: createdTotal > 0 ? completed / createdTotal : 0,
      avgE2eSeconds: parseFloatSafe(row?.avg_e2e_seconds),
      trafficCoverage: completed > 0 ? trafficCount / completed : 0,
    };
  }

  async getRecentDashboardJobs(windowMs: number, limit: number) {
    const windowSeconds = Math.max(1, Math.floor(windowMs / 1000));
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));

    const result = await this.pool.query<DashboardRecentRow>(
      `SELECT
         cj.id,
         cj.domain,
         cj.status,
         cj.priority,
         cj.stage,
         cj.updated_at,
         cj.error_message,
         COALESCE(
           (sp.report_json->'radar'->>'globalRank')::int,
           (sp.report_json->'trafficData'->>'globalRank')::int
         ) AS rank
       FROM crawl_jobs cj
       LEFT JOIN site_profiles sp ON sp.domain = cj.domain
       WHERE cj.updated_at >= NOW() - make_interval(secs => $1)
       ORDER BY cj.updated_at DESC
       LIMIT $2`,
      [windowSeconds, safeLimit],
    );

    return result.rows.map((row) => ({
      jobId: row.id,
      domain: row.domain,
      status: row.status,
      priority: row.priority,
      stage: row.stage ?? undefined,
      rank: row.rank,
      updatedAt: row.updated_at,
      errorMessage: row.error_message ?? undefined,
    }));
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}

export class PostgresCrawlTargetRepository implements CrawlTargetRepository {
  constructor(private readonly pool: Pool) {}

  async upsert(domain: string, options?: { priority?: number; isHighValue?: boolean }): Promise<CrawlTarget> {
    const result = await this.pool.query<CrawlTargetRow>(
      `INSERT INTO crawl_targets (domain, priority, is_high_value, created_at, updated_at)
       VALUES ($1, COALESCE($2, 1), COALESCE($3, false), NOW(), NOW())
       ON CONFLICT (domain)
       DO UPDATE SET
         priority = COALESCE($2, crawl_targets.priority),
         is_high_value = COALESCE($3, crawl_targets.is_high_value),
         updated_at = NOW()
       RETURNING *`,
      [domain, options?.priority ?? null, options?.isHighValue ?? null],
    );

    return mapCrawlTargetRow(result.rows[0]);
  }

  async getByDomain(domain: string): Promise<CrawlTarget | null> {
    const result = await this.pool.query<CrawlTargetRow>(
      `SELECT *
       FROM crawl_targets
       WHERE domain = $1
       LIMIT 1`,
      [domain],
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapCrawlTargetRow(result.rows[0]);
  }

  async getExistingDomains(domains: string[]): Promise<Set<string>> {
    if (domains.length === 0) {
      return new Set<string>();
    }

    const result = await this.pool.query<{ domain: string }>(
      `SELECT domain
       FROM crawl_targets
       WHERE domain = ANY($1::text[])`,
      [domains],
    );

    return new Set(result.rows.map((row) => row.domain));
  }

  async bulkUpsert(
    items: Array<{
      domain: string;
      priority?: number;
      isHighValue?: boolean;
      radarRank?: number;
    }>,
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }

    const domains = items.map((item) => item.domain);
    const priorities = items.map((item) => item.priority ?? null);
    const highValueFlags = items.map((item) => item.isHighValue ?? null);
    const radarRanks = items.map((item) => item.radarRank ?? null);

    await this.pool.query(
      `INSERT INTO crawl_targets (domain, priority, is_high_value, radar_rank, created_at, updated_at)
       SELECT
         data.domain,
         COALESCE(data.priority, 1),
         COALESCE(data.is_high_value, false),
         data.radar_rank,
         NOW(),
         NOW()
       FROM UNNEST($1::text[], $2::int[], $3::boolean[], $4::int[]) AS data(domain, priority, is_high_value, radar_rank)
       ON CONFLICT (domain)
       DO UPDATE SET
         priority = GREATEST(crawl_targets.priority, EXCLUDED.priority),
         is_high_value = crawl_targets.is_high_value OR EXCLUDED.is_high_value,
         radar_rank = COALESCE(EXCLUDED.radar_rank, crawl_targets.radar_rank),
         updated_at = NOW()`,
      [domains, priorities, highValueFlags, radarRanks],
    );
  }

  async bulkUpdateRadarRank(items: Array<{ domain: string; radarRank: number }>): Promise<void> {
    if (items.length === 0) {
      return;
    }

    const domains = items.map((item) => item.domain);
    const radarRanks = items.map((item) => item.radarRank);

    await this.pool.query(
      `UPDATE crawl_targets AS target
       SET radar_rank = data.radar_rank,
           updated_at = NOW()
       FROM UNNEST($1::text[], $2::int[]) AS data(domain, radar_rank)
       WHERE target.domain = data.domain`,
      [domains, radarRanks],
    );
  }

  async markLayerResult(
    domain: string,
    layer: 'browser' | 'async' | 'radar',
    status: CrawlTarget['lastBrowserStatus'],
    options?: { ttlSec?: number; errorBackoffSec?: number },
  ): Promise<void> {
    await this.upsert(domain);

    const ttlSec = options?.ttlSec
      ?? (layer === 'browser' ? DEFAULT_BROWSER_TTL_SEC : layer === 'radar' ? DEFAULT_RADAR_TTL_SEC : DEFAULT_ASYNC_TTL_SEC);

    const backoffSec = options?.errorBackoffSec ?? 24 * 3600;

    if (layer === 'browser') {
      await this.pool.query(
        `UPDATE crawl_targets
         SET last_browser_status = $2,
             last_browser_at = CASE WHEN $2 = 'success' THEN NOW() ELSE last_browser_at END,
             next_browser_at = CASE
               WHEN $2 = 'success' THEN NOW() + make_interval(secs => $3)
               WHEN $2 = 'failed' THEN NOW() + make_interval(secs => $4)
               ELSE next_browser_at
             END,
             error_count = CASE WHEN $2 = 'failed' THEN error_count + 1 ELSE error_count END,
             updated_at = NOW()
         WHERE domain = $1`,
        [domain, status, ttlSec, backoffSec],
      );
      return;
    }

    if (layer === 'radar') {
      await this.pool.query(
        `UPDATE crawl_targets
         SET last_radar_status = $2,
             last_radar_at = CASE WHEN $2 = 'success' THEN NOW() ELSE last_radar_at END,
             next_radar_at = CASE
               WHEN $2 = 'success' THEN NOW() + make_interval(secs => $3)
               WHEN $2 = 'failed' THEN NOW() + make_interval(secs => $4)
               ELSE next_radar_at
             END,
             error_count = CASE WHEN $2 = 'failed' THEN error_count + 1 ELSE error_count END,
             updated_at = NOW()
         WHERE domain = $1`,
        [domain, status, ttlSec, backoffSec],
      );
      return;
    }

    // async layer
    await this.pool.query(
      `UPDATE crawl_targets
       SET last_async_status = $2,
           last_async_at = CASE WHEN $2 = 'success' THEN NOW() ELSE last_async_at END,
           error_count = CASE WHEN $2 = 'failed' THEN error_count + 1 ELSE error_count END,
           updated_at = NOW()
       WHERE domain = $1`,
      [domain, status],
    );
  }

  async update(domain: string, patch: CrawlTargetUpdatePatch): Promise<void> {
    await this.upsert(domain);

    await this.pool.query(
        `UPDATE crawl_targets
       SET priority = COALESCE($2, priority),
           is_high_value = COALESCE($3, is_high_value),
           radar_rank = COALESCE($4, radar_rank),
           last_browser_at = COALESCE($5, last_browser_at),
           next_browser_at = COALESCE($6, next_browser_at),
           last_browser_status = COALESCE($7, last_browser_status),
           last_async_at = COALESCE($8, last_async_at),
           last_async_status = COALESCE($9, last_async_status),
           last_radar_at = COALESCE($10, last_radar_at),
           next_radar_at = COALESCE($11, next_radar_at),
           last_radar_status = COALESCE($12, last_radar_status),
           last_traffic_at = COALESCE($13, last_traffic_at),
           next_traffic_at = COALESCE($14, next_traffic_at),
           last_whois_at = COALESCE($15, last_whois_at),
           next_whois_at = COALESCE($16, next_whois_at),
           taxonomy_data = COALESCE($17::jsonb, taxonomy_data),
           taxonomy_updated_at = COALESCE($18, taxonomy_updated_at),
           taxonomy_model = COALESCE($19, taxonomy_model),
           taxonomy_prompt_version = COALESCE($20, taxonomy_prompt_version),
           taxonomy_last_trigger_reason = COALESCE($21, taxonomy_last_trigger_reason),
           taxonomy_source_lane = COALESCE($22, taxonomy_source_lane),
           last_content_hash = COALESCE($23, last_content_hash),
           error_count = COALESCE($24, error_count),
           whois_error_count = COALESCE($25, whois_error_count),
           updated_at = NOW()
       WHERE domain = $1`,
      [
        domain,
        patch.priority ?? null,
        patch.isHighValue ?? null,
        patch.radarRank ?? null,
        patch.lastBrowserAt ?? null,
        patch.nextBrowserAt ?? null,
        patch.lastBrowserStatus ?? null,
        patch.lastAsyncAt ?? null,
        patch.lastAsyncStatus ?? null,
        patch.lastRadarAt ?? null,
        patch.nextRadarAt ?? null,
        patch.lastRadarStatus ?? null,
        patch.lastTrafficAt ?? null,
        patch.nextTrafficAt ?? null,
        patch.lastWhoisAt ?? null,
        patch.nextWhoisAt ?? null,
        patch.taxonomyData ? safeJsonStringify(patch.taxonomyData) : null,
        patch.taxonomyUpdatedAt ?? null,
        patch.taxonomyModel ?? null,
        patch.taxonomyPromptVersion ?? null,
        patch.taxonomyLastTriggerReason ?? null,
        patch.taxonomySourceLane ?? null,
        patch.lastContentHash ?? null,
        patch.errorCount ?? null,
        patch.whoisErrorCount ?? null,
      ],
    );
  }

  async evaluateDue(domain: string, options?: TrafficRefreshOptions): Promise<CrawlTargetScheduleDue> {
    const target = await this.upsert(domain);
    const forceRefresh = options?.forceRefresh ?? false;
    const now = Date.now();

    const due = (value?: string) => {
      if (!value) {
        return true;
      }

      const timestamp = new Date(value).getTime();
      if (!Number.isFinite(timestamp)) {
        return true;
      }

      return now >= timestamp;
    };

    return {
      domain,
      isHighValue: target.isHighValue,
      radarRank: target.radarRank,
      needsBrowser: forceRefresh || due(target.nextBrowserAt),
      needsRadar: forceRefresh || due(target.nextRadarAt),
      needsAsync: forceRefresh || !target.lastAsyncAt,
    };
  }

  async getDueBatch(limit: number, options?: TrafficRefreshOptions): Promise<CrawlTargetScheduleDue[]> {
    const safeLimit = Math.max(1, Math.trunc(limit));
    const result = await this.pool.query<CrawlTargetRow>(
      `SELECT *
       FROM crawl_targets
       WHERE next_browser_at IS NULL
          OR next_radar_at IS NULL
          OR last_async_at IS NULL
          OR next_browser_at <= NOW()
          OR next_radar_at <= NOW()
       ORDER BY priority DESC, updated_at ASC
       LIMIT $1`,
      [safeLimit],
    );

    return result.rows.map((row) => {
      const target = mapCrawlTargetRow(row);
      const now = Date.now();
      const due = (value?: string) => {
        if (!value) {
          return true;
        }
        const timestamp = new Date(value).getTime();
        if (!Number.isFinite(timestamp)) {
          return true;
        }
        return now >= timestamp;
      };

      return {
        domain: target.domain,
        isHighValue: target.isHighValue,
        radarRank: target.radarRank,
        needsBrowser: due(target.nextBrowserAt),
        needsRadar: due(target.nextRadarAt),
        needsAsync: !target.lastAsyncAt,
      };
    });
  }

  async getTopByRadarRank(
    limit: number,
    options?: { dueOnly?: boolean },
  ): Promise<Array<{ domain: string; radarRank: number }>> {
    const safeLimit = Math.max(1, Math.trunc(limit));
    const dueOnly = options?.dueOnly ?? false;
    const result = await this.pool.query<{ domain: string; radar_rank: number }>(
      `SELECT domain, radar_rank
       FROM crawl_targets
       WHERE radar_rank IS NOT NULL
         ${dueOnly ? 'AND (next_traffic_at IS NULL OR next_traffic_at <= NOW())' : ''}
       ORDER BY radar_rank ASC
       LIMIT $1`,
      [safeLimit],
    );

    return result.rows.map((row) => ({
      domain: row.domain,
      radarRank: row.radar_rank,
    }));
  }

  async getFastlaneTrafficDomains(
    limit: number,
    options?: { maxSnapshotAgeDays?: number },
  ): Promise<string[]> {
    const safeLimit = Math.max(1, Math.trunc(limit));
    const maxSnapshotAgeDays = Math.max(1, Math.trunc(options?.maxSnapshotAgeDays ?? 30));
    const result = await this.pool.query<{ domain: string }>(
      `SELECT domain
       FROM crawl_targets
       WHERE (next_traffic_at IS NULL OR next_traffic_at <= NOW())
         AND (
           last_traffic_at IS NULL
           OR last_traffic_at <= NOW() - (($2::text || ' days')::interval)
         )
       ORDER BY radar_rank ASC NULLS LAST, priority DESC, updated_at ASC
       LIMIT $1`,
      [safeLimit, maxSnapshotAgeDays],
    );

    return result.rows.map((row) => row.domain);
  }

  async getHighRankFirstRunDomains(
    limit: number,
    options?: { maxRadarRank?: number },
  ): Promise<Array<{ domain: string; radarRank: number; isHighValue: boolean }>> {
    const safeLimit = Math.max(1, Math.trunc(limit));
    const maxRadarRank = Math.max(1, Math.trunc(options?.maxRadarRank ?? 100_000));

    const result = await this.pool.query<{ domain: string; radar_rank: number; is_high_value: boolean }>(
      `SELECT domain, radar_rank, is_high_value
       FROM crawl_targets
       WHERE radar_rank IS NOT NULL
         AND radar_rank > 0
         AND radar_rank <= $2
         AND last_browser_at IS NULL
         AND last_browser_status IS NULL
       ORDER BY radar_rank ASC, priority DESC, updated_at ASC
       LIMIT $1`,
      [safeLimit, maxRadarRank],
    );

    return result.rows.map((row) => ({
      domain: row.domain,
      radarRank: row.radar_rank,
      isHighValue: row.is_high_value || row.radar_rank <= 100_000,
    }));
  }

  async claimHighRankFirstRunDomains(
    limit: number,
    options?: { maxRadarRank?: number },
  ): Promise<Array<{ domain: string; radarRank: number; isHighValue: boolean }>> {
    const safeLimit = Math.max(1, Math.trunc(limit));
    const maxRadarRank = Math.max(1, Math.trunc(options?.maxRadarRank ?? 100_000));

    const result = await this.pool.query<{ domain: string; radar_rank: number; is_high_value: boolean }>(
      `WITH picked AS (
         SELECT domain, radar_rank, is_high_value
         FROM crawl_targets
         WHERE radar_rank IS NOT NULL
           AND radar_rank > 0
           AND radar_rank <= $2
           AND last_browser_at IS NULL
           AND last_browser_status IS NULL
         ORDER BY radar_rank ASC, priority DESC, updated_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE crawl_targets AS target
       SET last_browser_status = 'pending',
           updated_at = NOW()
       FROM picked
       WHERE target.domain = picked.domain
       RETURNING target.domain, target.radar_rank, target.is_high_value`,
      [safeLimit, maxRadarRank],
    );

    return result.rows.map((row) => ({
      domain: row.domain,
      radarRank: row.radar_rank,
      isHighValue: row.is_high_value || row.radar_rank <= 100_000,
    }));
  }

  async releaseClaimedFirstRunDomains(domains: string[]): Promise<void> {
    if (domains.length === 0) {
      return;
    }

    await this.pool.query(
      `UPDATE crawl_targets
       SET last_browser_status = NULL,
           updated_at = NOW()
       WHERE domain = ANY($1::text[])
         AND last_browser_at IS NULL
         AND last_browser_status = 'pending'`,
      [domains],
    );
  }

  async getBrowserSuccessTaxonomyMissingDomains(
    limit: number,
    options?: { maxRadarRank?: number; currentPromptVersion?: number },
  ): Promise<Array<{ domain: string; radarRank?: number; isHighValue: boolean }>> {
    const safeLimit = Math.max(1, Math.trunc(limit));
    const maxRadarRank = options?.maxRadarRank ? Math.max(1, Math.trunc(options.maxRadarRank)) : null;
    const currentPromptVersion = options?.currentPromptVersion ?? null;

    const result = await this.pool.query<{ domain: string; radar_rank: number | null; is_high_value: boolean }>(
      `SELECT target.domain, target.radar_rank, target.is_high_value
       FROM crawl_targets AS target
       JOIN site_profiles AS profile
         ON profile.domain = target.domain
       WHERE target.last_browser_status = 'success'
         AND (
           $2::int IS NULL
           OR (target.radar_rank IS NOT NULL AND target.radar_rank > 0 AND target.radar_rank <= $2)
         )
         AND (
           /* Case 1: taxonomy missing + ai.provider previously failed */
           (target.taxonomy_data IS NULL AND EXISTS (
             SELECT 1
             FROM jsonb_array_elements(COALESCE(profile.report_json->'providerHealth', '[]'::jsonb)) AS provider(item)
             WHERE provider.item->>'provider' = 'ai.provider'
               AND COALESCE((provider.item->>'ok')::boolean, false) = false
           ))
           OR
           /* Case 2: taxonomy exists but prompt version outdated (vision upgrade) */
           ($3::int IS NOT NULL AND target.taxonomy_data IS NOT NULL
             AND (target.taxonomy_prompt_version IS NULL OR target.taxonomy_prompt_version < $3))
         )
       ORDER BY target.radar_rank ASC NULLS LAST, target.priority DESC, target.updated_at ASC
       LIMIT $1`,
      [safeLimit, maxRadarRank, currentPromptVersion],
    );

    return result.rows.map((row) => ({
      domain: row.domain,
      radarRank: row.radar_rank ?? undefined,
      isHighValue: row.is_high_value || (typeof row.radar_rank === 'number' && row.radar_rank <= 100_000),
    }));
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1 FROM crawl_targets LIMIT 1');
      return true;
    } catch {
      return false;
    }
  }
}

export const createPostgresPool = (databaseUrl: string): Pool => {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
};

export const ensurePostgresSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_profiles (
      domain TEXT PRIMARY KEY,
      updated_at TIMESTAMPTZ NOT NULL,
      freshness_ttl_sec INTEGER,
      report_json JSONB NOT NULL,
      category_text TEXT,
      rank_int INTEGER,
      tags_search TEXT[] NOT NULL DEFAULT '{}',
      tech_search TEXT[] NOT NULL DEFAULT '{}'
    );
  `);

  await pool.query('ALTER TABLE site_profiles ADD COLUMN IF NOT EXISTS category_text TEXT');
  await pool.query('ALTER TABLE site_profiles ADD COLUMN IF NOT EXISTS rank_int INTEGER');
  await pool.query("ALTER TABLE site_profiles ADD COLUMN IF NOT EXISTS tags_search TEXT[] NOT NULL DEFAULT '{}'::text[]");
  await pool.query("ALTER TABLE site_profiles ADD COLUMN IF NOT EXISTS tech_search TEXT[] NOT NULL DEFAULT '{}'::text[]");
  await pool.query('ALTER TABLE site_profiles ADD COLUMN IF NOT EXISTS traffic_rank_int INTEGER');
  await pool.query('ALTER TABLE site_profiles ADD COLUMN IF NOT EXISTS legitimacy_score_int SMALLINT');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS crawl_jobs (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      progress INTEGER NOT NULL,
      stage TEXT,
      trace_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      error_message TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS radar_snapshots (
      domain TEXT PRIMARY KEY,
      updated_at TIMESTAMPTZ NOT NULL,
      payload_json JSONB NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS crawl_targets (
      domain TEXT PRIMARY KEY,
      priority INTEGER NOT NULL DEFAULT 1,
      is_high_value BOOLEAN NOT NULL DEFAULT false,
      radar_rank INTEGER,
      last_browser_at TIMESTAMPTZ,
      next_browser_at TIMESTAMPTZ,
      last_browser_status TEXT,
      last_async_at TIMESTAMPTZ,
      last_async_status TEXT,
      last_radar_at TIMESTAMPTZ,
      next_radar_at TIMESTAMPTZ,
      last_radar_status TEXT,
      last_traffic_at TIMESTAMPTZ,
      next_traffic_at TIMESTAMPTZ,
      last_whois_at TIMESTAMPTZ,
      next_whois_at TIMESTAMPTZ,
      taxonomy_data JSONB,
      taxonomy_updated_at TIMESTAMPTZ,
      taxonomy_model TEXT,
      taxonomy_prompt_version INTEGER,
      taxonomy_last_trigger_reason TEXT,
      taxonomy_source_lane TEXT,
      last_content_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      error_count INTEGER NOT NULL DEFAULT 0,
      whois_error_count INTEGER NOT NULL DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_alternatives_cache (
      domain TEXT PRIMARY KEY,
      algorithm_version TEXT NOT NULL,
      source_report_updated_at TIMESTAMPTZ,
      items_json JSONB NOT NULL,
      quality_score DOUBLE PRECISION NOT NULL DEFAULT 0,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  // Migration: add new columns for existing tables
  await pool.query('ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS radar_rank INTEGER');
  await pool.query('ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS last_browser_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS next_browser_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS last_browser_status TEXT');
  await pool.query('ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS last_async_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS last_async_status TEXT');
  await pool.query('ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS last_whois_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS next_whois_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS whois_error_count INTEGER NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS taxonomy_prompt_version INTEGER');
  await pool.query('ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS taxonomy_last_trigger_reason TEXT');
  await pool.query('ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS taxonomy_source_lane TEXT');

  // Backfill safeguard: keep only the newest active job per domain before creating uniqueness index.
  await pool.query(`
    WITH ranked_active AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY domain
          ORDER BY created_at DESC, id DESC
        ) AS rn
      FROM crawl_jobs
      WHERE status IN ('pending', 'running')
    )
    UPDATE crawl_jobs AS cj
    SET status = 'failed',
        stage = COALESCE(cj.stage, 'deduplicated_active_conflict'),
        error_message = COALESCE(cj.error_message, 'Deduplicated: newer active job exists'),
        updated_at = NOW()
    FROM ranked_active AS ra
    WHERE cj.id = ra.id
      AND ra.rn > 1;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_crawl_jobs_domain_active
      ON crawl_jobs (domain)
      WHERE status IN ('pending', 'running');
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_crawl_jobs_domain_status
      ON crawl_jobs (domain, status, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_site_profiles_updated_at
      ON site_profiles (updated_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_site_profiles_category_rank
      ON site_profiles (category_text, rank_int)
      WHERE category_text IS NOT NULL AND rank_int IS NOT NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_site_profiles_category_rank_traffic
      ON site_profiles (category_text, rank_int ASC NULLS LAST, traffic_rank_int ASC NULLS LAST)
      WHERE category_text IS NOT NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_site_profiles_rank
      ON site_profiles (rank_int)
      WHERE rank_int IS NOT NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_site_profiles_traffic_rank
      ON site_profiles (traffic_rank_int)
      WHERE traffic_rank_int IS NOT NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_site_profiles_tags_search_gin
      ON site_profiles USING GIN (tags_search);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_site_profiles_tech_search_gin
      ON site_profiles USING GIN (tech_search);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_site_alternatives_cache_expires_at
      ON site_alternatives_cache (expires_at);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_site_alternatives_cache_quality
      ON site_alternatives_cache (quality_score DESC, generated_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_crawl_jobs_updated_at
      ON crawl_jobs (updated_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_crawl_jobs_status_updated_at
      ON crawl_jobs (status, updated_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_radar_snapshots_updated_at
      ON radar_snapshots (updated_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_crawl_targets_next_browser_at
      ON crawl_targets (next_browser_at)
      WHERE next_browser_at IS NOT NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_crawl_targets_next_radar_at
      ON crawl_targets (next_radar_at)
      WHERE next_radar_at IS NOT NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_crawl_targets_next_traffic_at
      ON crawl_targets (next_traffic_at)
      WHERE next_traffic_at IS NOT NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_crawl_targets_next_whois_at
      ON crawl_targets (next_whois_at)
      WHERE next_whois_at IS NOT NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_crawl_targets_radar_rank
      ON crawl_targets (radar_rank ASC)
      WHERE radar_rank IS NOT NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_crawl_targets_priority_updated
      ON crawl_targets (priority DESC, updated_at ASC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_crawl_targets_first_run_rank
      ON crawl_targets (radar_rank ASC, priority DESC, updated_at ASC)
      WHERE radar_rank IS NOT NULL
        AND last_browser_at IS NULL
        AND last_browser_status IS NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_crawl_targets_ai_retry
      ON crawl_targets (radar_rank ASC, priority DESC, updated_at ASC)
      WHERE last_browser_status = 'success'
        AND taxonomy_data IS NULL;
  `);
};
