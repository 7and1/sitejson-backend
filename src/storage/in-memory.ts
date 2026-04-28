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
  TrafficRefreshOptions,
} from './interfaces.js';
import { sanitizeSiteReport } from '../services/report-merge.js';
import { calculateLegitimacyScore } from '../scoring/legitimacy.js';
import { normalizeDirectoryList, normalizeDirectorySlug } from './directory-slug.js';

const safeNumber = (value: number): number => {
  return Number.isFinite(value) ? value : 0;
};

const normalizeSlug = normalizeDirectorySlug;
const normalizeList = normalizeDirectoryList;
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

const normalizeAlternativeList = (values: string[] | undefined): string[] => (
  normalizeList(values).filter(isHighSignalAlternativeSlug)
);

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

const ALTERNATIVES_CACHE_TTL_MS = 15 * 60 * 1000;

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

const nowIso = () => new Date().toISOString();

const DEFAULT_BROWSER_TTL_SEC = 365 * 24 * 3600;
const DEFAULT_RADAR_TTL_SEC = 7 * 24 * 3600;
const DEFAULT_ASYNC_TTL_SEC = 30 * 24 * 3600;

const toFutureIso = (seconds: number): string => {
  return new Date(Date.now() + seconds * 1000).toISOString();
};

const isDue = (value?: string): boolean => {
  if (!value) {
    return true;
  }

  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return true;
  }

  return Date.now() >= timestamp;
};

export class InMemorySiteRepository implements SiteRepository {
  private readonly reports = new Map<string, SiteReport>();
  private readonly alternativesCache = new Map<string, { result: AlternativeSearchResult; expiresAt: number }>();

  async getByDomain(domain: string): Promise<SiteReport | null> {
    const report = this.reports.get(domain);
    return report ? sanitizeSiteReport(report) : null;
  }

  async upsert(report: SiteReport): Promise<void> {
    const sanitizedReport = sanitizeSiteReport(report);
    this.reports.set(sanitizedReport.domain, sanitizedReport);

    const prefix = `${sanitizedReport.domain}:`;
    for (const key of this.alternativesCache.keys()) {
      if (key.startsWith(prefix)) {
        this.alternativesCache.delete(key);
      }
    }
  }

  async searchDirectory(type: DirectoryType, slug: string, page: number, pageSize: number, options?: DirectorySearchOptions) {
    let reports = Array.from(this.reports.values())
      .filter((report) => matchesDirectory(report, type, slug));

    if (options?.minScore !== undefined && Number.isFinite(options.minScore)) {
      reports = reports.filter((r) => calculateLegitimacyScore(r).value >= options.minScore!);
    }

    if (options?.hasTraffic) {
      reports = reports.filter((r) => typeof r.trafficData?.globalRank === 'number' && r.trafficData.globalRank > 0);
    }

    const items = reports.map((report) => toDirectoryItem(report));

    const sortedItems = [...items];
    if (options?.sort === 'traffic') {
      sortedItems.sort((a, b) => (a.monthlyVisits ?? 0) - (b.monthlyVisits ?? 0));
    } else if (options?.sort === 'score') {
      sortedItems.sort((a, b) => (b.legitimacyScore ?? 0) - (a.legitimacyScore ?? 0));
    } else {
      sortedItems.sort(compareDirectoryItems);
    }

    const safePage = Math.max(1, page);
    const safePageSize = Math.max(1, pageSize);
    const offset = (safePage - 1) * safePageSize;

    return {
      items: sortedItems.slice(offset, offset + safePageSize),
      total: sortedItems.length,
    };
  }

  async getDirectoryStats(type: DirectoryType, slug: string): Promise<DirectoryStats> {
    const reports = Array.from(this.reports.values())
      .filter((report) => matchesDirectory(report, type, slug));

    const total = reports.length;
    const scores = reports.map((r) => calculateLegitimacyScore(r).value);
    const avgLegitimacyScore = scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : null;

    let top10k = 0, top100k = 0, top1m = 0, unranked = 0;
    let hasTrafficData = 0;
    const techCount = new Map<string, number>();
    const tagCount = new Map<string, number>();
    const countryCount = new Map<string, number>();

    for (const r of reports) {
      const rank = r.radar?.globalRank ?? null;
      if (rank !== null && rank <= 10_000) top10k++;
      else if (rank !== null && rank <= 100_000) top100k++;
      else if (rank !== null && rank <= 1_000_000) top1m++;
      else unranked++;

      if (typeof r.trafficData?.globalRank === 'number') hasTrafficData++;

      for (const t of normalizeList(r.meta?.techStackDetected)) {
        techCount.set(t, (techCount.get(t) ?? 0) + 1);
      }
      for (const t of normalizeList(r.taxonomy?.tags)) {
        tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
      }
      if (r.trafficData?.topCountry) {
        countryCount.set(r.trafficData.topCountry, (countryCount.get(r.trafficData.topCountry) ?? 0) + 1);
      }
    }

    const sortByCount = (m: Map<string, number>, limit: number) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

    return {
      type,
      slug,
      total,
      avgLegitimacyScore,
      trafficDistribution: { top10k, top100k, top1m, unranked },
      topTechnologies: sortByCount(techCount, 10).map(([name, count]) => ({ name, count })),
      topTags: sortByCount(tagCount, 10).map(([name, count]) => ({ name, count })),
      topCountries: sortByCount(countryCount, 10).map(([country, count]) => ({ country, count })),
      hasTrafficData,
    };
  }

  async getDirectoryTypeSummary(type: DirectoryType, limit = 50): Promise<DirectoryTypeSummary> {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const reports = Array.from(this.reports.values());
    const slugCount = new Map<string, number>();
    const slugTopDomain = new Map<string, { domain: string; title: string; rank: number }>();

    for (const r of reports) {
      let slugs: string[] = [];
      if (type === 'category') {
        const cat = normalizeSlug(r.taxonomy?.iabCategory ?? '');
        if (cat && cat !== 'uncategorized') slugs = [cat];
      } else if (type === 'technology') {
        slugs = normalizeList(r.meta?.techStackDetected);
      } else {
        slugs = normalizeList(r.taxonomy?.tags);
      }

      const rank = (r.radar?.globalRank ?? r.trafficData?.globalRank ?? Infinity) as number;
      for (const s of slugs) {
        slugCount.set(s, (slugCount.get(s) ?? 0) + 1);
        const existing = slugTopDomain.get(s);
        if (!existing || rank < existing.rank) {
          slugTopDomain.set(s, { domain: r.domain, title: r.meta?.title ?? r.domain, rank });
        }
      }
    }

    const sorted = [...slugCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, safeLimit);

    const slugs = sorted.map(([slug, count]) => {
      const top = slugTopDomain.get(slug);
      return {
        slug,
        count,
        topDomain: top?.domain,
        topTitle: top?.title,
      };
    });

    return {
      type,
      totalSlugs: slugs.length,
      totalSites: slugs.reduce((s, x) => s + x.count, 0),
      slugs,
    };
  }

  async getGlobalInsights(): Promise<GlobalInsights> {
    const reports = Array.from(this.reports.values());
    const catCount = new Map<string, number>();
    const techCount = new Map<string, number>();
    const tagCount = new Map<string, number>();

    let withTraffic = 0;
    let withScore = 0;
    let high = 0, medium = 0, low = 0, unscored = 0;

    for (const r of reports) {
      if (typeof r.trafficData?.globalRank === 'number') withTraffic++;

      const score = calculateLegitimacyScore(r).value;
      withScore++;
      if (score >= 70) high++;
      else if (score >= 40) medium++;
      else low++;

      const cat = normalizeSlug(r.taxonomy?.iabCategory ?? '');
      if (cat && cat !== 'uncategorized') catCount.set(cat, (catCount.get(cat) ?? 0) + 1);

      for (const t of normalizeList(r.meta?.techStackDetected)) {
        techCount.set(t, (techCount.get(t) ?? 0) + 1);
      }
      for (const t of normalizeList(r.taxonomy?.tags)) {
        tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
      }
    }

    const sortByCount = (m: Map<string, number>, limit: number) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

    return {
      totalSites: reports.length,
      withTraffic,
      withScore,
      scoreDistribution: { high, medium, low, unscored },
      topCategories: sortByCount(catCount, 10).map(([slug, count]) => ({ slug, count })),
      topTechnologies: sortByCount(techCount, 10).map(([name, count]) => ({ name, count })),
      topTopics: sortByCount(tagCount, 10).map(([name, count]) => ({ name, count })),
    };
  }

  async findAlternatives(domain: string, limit: number): Promise<AlternativeSearchResult | null> {
    const target = this.reports.get(domain);
    if (!target) {
      return null;
    }

    const targetCategory = categoryFromReport(target);
    const targetRank = rankForAlternatives(target);
    const targetTrafficRank = trafficRankFromReport(target);
    const targetTags = normalizeAlternativeList(target.taxonomy?.tags);
    const targetTech = normalizeList(target.meta?.techStackDetected);

    const safeLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
    const cacheKey = `${domain}:${safeLimit}:${target.updatedAt}`;
    const now = Date.now();
    for (const [key, value] of this.alternativesCache.entries()) {
      if (value.expiresAt <= now) {
        this.alternativesCache.delete(key);
      }
    }
    const cached = this.alternativesCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.result;
    }

    // Need at least one signal to find alternatives
    if (!targetCategory && targetTags.length === 0 && !targetRank && !targetTrafficRank) {
      const emptyResult: AlternativeSearchResult = {
        algorithm: 'rule_based',
        items: [],
      };
      this.alternativesCache.set(cacheKey, {
        result: emptyResult,
        expiresAt: now + ALTERNATIVES_CACHE_TTL_MS,
      });
      return emptyResult;
    }

    // Rank band boundaries (0.1x – 10x)
    const minRadarRank = targetRank ? Math.max(1, Math.floor(targetRank * 0.1)) : null;
    const maxRadarRank = targetRank ? Math.ceil(targetRank * 10) : null;
    const minTrafficRank = targetTrafficRank ? Math.max(1, Math.floor(targetTrafficRank * 0.1)) : null;
    const maxTrafficRank = targetTrafficRank ? Math.ceil(targetTrafficRank * 10) : null;

    // Multi-tier candidate selection: category OR tag/tech overlap OR rank proximity
    const candidateSet = new Set<string>();
    const candidates: SiteReport[] = [];

    const addCandidate = (report: SiteReport) => {
      if (candidateSet.has(report.domain) || report.domain === domain) return;
      candidateSet.add(report.domain);
      candidates.push(report);
    };

    for (const candidate of this.reports.values()) {
      if (candidate.domain === domain) continue;

      const candidateCategory = categoryFromReport(candidate);
      const candidateRank = rankForAlternatives(candidate);
      const candidateTrafficRank = trafficRankFromReport(candidate);
      const candidateTags = normalizeAlternativeList(candidate.taxonomy?.tags);
      const candidateTech = normalizeList(candidate.meta?.techStackDetected);

      // Tier 1: Same category
      if (targetCategory && candidateCategory === targetCategory) {
        addCandidate(candidate);
        continue;
      }

      // Tier 2: Tag or tech overlap
      if (targetTags.length > 0 && candidateTags.some((t) => targetTags.includes(t))) {
        addCandidate(candidate);
        continue;
      }
      if (targetTech.length > 0 && candidateTech.some((t) => targetTech.includes(t))) {
        addCandidate(candidate);
        continue;
      }

      // Tier 3: Rank proximity on either dimension
      if (minRadarRank !== null && maxRadarRank !== null && candidateRank
          && candidateRank >= minRadarRank && candidateRank <= maxRadarRank) {
        addCandidate(candidate);
        continue;
      }
      if (minTrafficRank !== null && maxTrafficRank !== null && candidateTrafficRank
          && candidateTrafficRank >= minTrafficRank && candidateTrafficRank <= maxTrafficRank) {
        addCandidate(candidate);
      }
    }

    const items = candidates
      .map((candidate) => {
        const candidateCategory = categoryFromReport(candidate);
        const candidateRank = rankForAlternatives(candidate);
        const candidateTrafficRank = trafficRankFromReport(candidate);
        const candidateTags = normalizeAlternativeList(candidate.taxonomy?.tags);
        const candidateTech = normalizeList(candidate.meta?.techStackDetected);

        const tagJaccard = jaccardScore(targetTags, candidateTags);
        const techJaccard = jaccardScore(targetTech, candidateTech);
        const catMatch = (targetCategory && candidateCategory === targetCategory) ? 1.0 : 0.0;

        // Radar rank proximity
        const radarProx = (targetRank && candidateRank && candidateRank > 0)
          ? rankProximityScore(targetRank, candidateRank) : null;

        // Traffic rank proximity
        const trafficProx = (targetTrafficRank && candidateTrafficRank && candidateTrafficRank > 0)
          ? rankProximityScore(targetTrafficRank, candidateTrafficRank) : null;

        // Compute weighted score with dynamic redistribution
        let rankComponent: number;
        if (radarProx !== null && trafficProx !== null) {
          rankComponent = 0.20 * radarProx + 0.20 * trafficProx;
        } else if (radarProx !== null) {
          rankComponent = 0.40 * radarProx;
        } else if (trafficProx !== null) {
          rankComponent = 0.40 * trafficProx;
        } else {
          // Redistribute to tags
          rankComponent = 0.25 * tagJaccard;
        }

        const score = 0.20 * catMatch + 0.25 * tagJaccard + rankComponent + 0.15 * techJaccard;

        const reasons: string[] = [];
        if (catMatch > 0) reasons.push('same_category');
        if (radarProx !== null) reasons.push('similar_rank_band');
        if (trafficProx !== null) reasons.push('similar_traffic_rank');
        if (tagJaccard > 0) reasons.push('high_tag_overlap');
        if (techJaccard > 0) reasons.push('shared_tech_stack');

        const displayRank = candidateRank ?? 0;

        return {
          domain: candidate.domain,
          title: candidate.meta?.title ?? candidate.domain,
          rank: displayRank,
          score: Number.parseFloat(score.toFixed(6)),
          reasons,
        };
      })
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return (left.rank || 999999999) - (right.rank || 999999999);
      })
      .slice(0, safeLimit);

    const alternativesResult: AlternativeSearchResult = {
      algorithm: 'rule_based',
      items,
    };
    this.alternativesCache.set(cacheKey, {
      result: alternativesResult,
      expiresAt: now + ALTERNATIVES_CACHE_TTL_MS,
    });
    return alternativesResult;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

export class InMemoryRadarSnapshotRepository implements RadarSnapshotRepository {
  private readonly snapshots = new Map<string, RadarSnapshot>();

  async getByDomain(domain: string): Promise<RadarSnapshot | null> {
    return this.snapshots.get(domain) ?? null;
  }

  async upsert(snapshot: RadarSnapshot): Promise<void> {
    this.snapshots.set(snapshot.domain, snapshot);
  }

  async bulkUpsert(snapshots: RadarSnapshot[]): Promise<void> {
    for (const snapshot of snapshots) {
      this.snapshots.set(snapshot.domain, snapshot);
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, CrawlJob>();

  private toProgress(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fallback;
    }

    return Math.max(0, Math.min(100, Math.trunc(value)));
  }

  async create(job: CrawlJob): Promise<void> {
    this.jobs.set(job.id, job);
  }

  async createPendingIfAbsent(job: CrawlJob): Promise<{ created: boolean; existingJobId?: string }> {
    for (const existing of this.jobs.values()) {
      if (existing.domain === job.domain && (existing.status === 'pending' || existing.status === 'running')) {
        return { created: false, existingJobId: existing.id };
      }
    }

    this.jobs.set(job.id, job);
    return { created: true };
  }

  async getById(id: string): Promise<CrawlJob | null> {
    return this.jobs.get(id) ?? null;
  }

  async update(job: CrawlJob): Promise<void> {
    this.jobs.set(job.id, job);
  }

  async markRunning(jobId: string, stage: string, progress?: number): Promise<void> {
    const existing = this.jobs.get(jobId);
    if (!existing || existing.status === 'completed' || existing.status === 'failed') {
      return;
    }

    this.jobs.set(jobId, {
      ...existing,
      status: 'running',
      stage,
      progress: this.toProgress(progress, existing.progress),
      errorMessage: undefined,
      updatedAt: nowIso(),
    });
  }

  async markCompleted(jobId: string, stage = 'done', progress = 100): Promise<void> {
    const existing = this.jobs.get(jobId);
    if (!existing || existing.status === 'completed' || existing.status === 'failed') {
      return;
    }

    this.jobs.set(jobId, {
      ...existing,
      status: 'completed',
      stage,
      progress: this.toProgress(progress, 100),
      updatedAt: nowIso(),
    });
  }

  async markFailed(jobId: string, errorMessage: string, stage = 'failed'): Promise<void> {
    const existing = this.jobs.get(jobId);
    if (!existing || existing.status === 'completed' || existing.status === 'failed') {
      return;
    }

    this.jobs.set(jobId, {
      ...existing,
      status: 'failed',
      stage,
      errorMessage,
      updatedAt: nowIso(),
    });
  }

  async findRunningByDomain(domain: string): Promise<CrawlJob | null> {
    for (const job of this.jobs.values()) {
      if (job.domain === domain && (job.status === 'pending' || job.status === 'running')) {
        return job;
      }
    }
    return null;
  }

  async getDashboardJobStats(windowMs: number) {
    const now = Date.now();
    const jobsInWindow = Array.from(this.jobs.values()).filter((job) => {
      const updatedAtMs = new Date(job.updatedAt).getTime();
      return Number.isFinite(updatedAtMs) && now - updatedAtMs <= windowMs;
    });

    const createdTotal = jobsInWindow.length;
    const running = jobsInWindow.filter((job) => job.status === 'running').length;
    const completed = jobsInWindow.filter((job) => job.status === 'completed').length;
    const failed = jobsInWindow.filter((job) => job.status === 'failed').length;
    const successRate = createdTotal > 0 ? completed / createdTotal : 0;

    const completedDurations = jobsInWindow
      .filter((job) => job.status === 'completed')
      .map((job) => {
        const createdAtMs = new Date(job.createdAt).getTime();
        const updatedAtMs = new Date(job.updatedAt).getTime();
        if (!Number.isFinite(createdAtMs) || !Number.isFinite(updatedAtMs)) {
          return 0;
        }
        return Math.max(0, (updatedAtMs - createdAtMs) / 1000);
      });

    const avgE2eSeconds = completedDurations.length > 0
      ? safeNumber(completedDurations.reduce((sum, duration) => sum + duration, 0) / completedDurations.length)
      : 0;

    return {
      createdTotal,
      running,
      completed,
      failed,
      successRate: safeNumber(successRate),
      avgE2eSeconds,
      trafficCoverage: 0,
    };
  }

  async getRecentDashboardJobs(windowMs: number, limit: number) {
    const now = Date.now();
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const items = Array.from(this.jobs.values())
      .filter((job) => {
        const updatedAtMs = new Date(job.updatedAt).getTime();
        return Number.isFinite(updatedAtMs) && now - updatedAtMs <= windowMs;
      })
      .sort((left, right) => {
        const leftMs = new Date(left.updatedAt).getTime();
        const rightMs = new Date(right.updatedAt).getTime();
        return rightMs - leftMs;
      })
      .slice(0, safeLimit)
      .map((job) => ({
        jobId: job.id,
        domain: job.domain,
        status: job.status,
        priority: job.priority,
        stage: job.stage,
        rank: null,
        updatedAt: job.updatedAt,
        errorMessage: job.errorMessage,
      }));

    return items;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

export class InMemoryCrawlTargetRepository implements CrawlTargetRepository {
  private readonly targets = new Map<string, CrawlTarget>();

  async upsert(domain: string, options?: { priority?: number; isHighValue?: boolean }): Promise<CrawlTarget> {
    const existing = this.targets.get(domain);
    const now = nowIso();

    if (existing) {
      const next: CrawlTarget = {
        ...existing,
        priority: options?.priority ?? existing.priority,
        isHighValue: options?.isHighValue ?? existing.isHighValue,
        updatedAt: now,
      };
      this.targets.set(domain, next);
      return next;
    }

    const created: CrawlTarget = {
      domain,
      priority: options?.priority ?? 1,
      isHighValue: options?.isHighValue ?? false,
      createdAt: now,
      updatedAt: now,
      errorCount: 0,
      whoisErrorCount: 0,
    };
    this.targets.set(domain, created);
    return created;
  }

  async getByDomain(domain: string): Promise<CrawlTarget | null> {
    return this.targets.get(domain) ?? null;
  }

  async getExistingDomains(domains: string[]): Promise<Set<string>> {
    const existing = new Set<string>();

    for (const domain of domains) {
      if (this.targets.has(domain)) {
        existing.add(domain);
      }
    }

    return existing;
  }

  async bulkUpsert(
    items: Array<{
      domain: string;
      priority?: number;
      isHighValue?: boolean;
      radarRank?: number;
    }>,
  ): Promise<void> {
    for (const item of items) {
      const current = await this.upsert(item.domain, {
        priority: item.priority,
        isHighValue: item.isHighValue,
      });

      const next: CrawlTarget = {
        ...current,
        radarRank: item.radarRank ?? current.radarRank,
        updatedAt: nowIso(),
      };
      this.targets.set(item.domain, next);
    }
  }

  async bulkUpdateRadarRank(items: Array<{ domain: string; radarRank: number }>): Promise<void> {
    for (const item of items) {
      const current = await this.upsert(item.domain);
      const next: CrawlTarget = {
        ...current,
        radarRank: item.radarRank,
        updatedAt: nowIso(),
      };
      this.targets.set(item.domain, next);
    }
  }

  async markLayerResult(
    domain: string,
    layer: 'browser' | 'async' | 'radar',
    status: CrawlTarget['lastBrowserStatus'],
    options?: { ttlSec?: number; errorBackoffSec?: number },
  ): Promise<void> {
    const target = await this.upsert(domain);
    const now = nowIso();
    const errorBackoffSec = options?.errorBackoffSec ?? 24 * 3600;

    if (layer === 'browser') {
      target.lastBrowserStatus = status;
      if (status === 'success') {
        target.lastBrowserAt = now;
        target.nextBrowserAt = toFutureIso(options?.ttlSec ?? DEFAULT_BROWSER_TTL_SEC);
      }
      if (status === 'failed') {
        target.nextBrowserAt = toFutureIso(errorBackoffSec);
      }
    }

    if (layer === 'radar') {
      target.lastRadarStatus = status;
      if (status === 'success') {
        target.lastRadarAt = now;
        target.nextRadarAt = toFutureIso(options?.ttlSec ?? DEFAULT_RADAR_TTL_SEC);
      }
      if (status === 'failed') {
        target.nextRadarAt = toFutureIso(errorBackoffSec);
      }
    }

    if (layer === 'async') {
      target.lastAsyncStatus = status;
      if (status === 'success') {
        target.lastAsyncAt = now;
      }
    }

    if (status === 'failed') {
      target.errorCount += 1;
    }

    target.updatedAt = now;
    this.targets.set(domain, target);
  }

  async update(domain: string, patch: CrawlTargetUpdatePatch): Promise<void> {
    const current = await this.upsert(domain);
    const next: CrawlTarget = {
      ...current,
      ...patch,
      updatedAt: nowIso(),
    };
    this.targets.set(domain, next);
  }

  async evaluateDue(domain: string, options?: TrafficRefreshOptions): Promise<CrawlTargetScheduleDue> {
    const target = await this.upsert(domain);
    const forceRefresh = options?.forceRefresh ?? false;

    return {
      domain,
      isHighValue: target.isHighValue,
      radarRank: target.radarRank,
      needsBrowser: forceRefresh || isDue(target.nextBrowserAt),
      needsRadar: forceRefresh || isDue(target.nextRadarAt),
      needsAsync: forceRefresh || !target.lastAsyncAt,
    };
  }

  async getDueBatch(limit: number, _options?: TrafficRefreshOptions): Promise<CrawlTargetScheduleDue[]> {
    const safeLimit = Math.max(1, limit);
    const due: CrawlTargetScheduleDue[] = [];

    for (const target of this.targets.values()) {
      due.push({
        domain: target.domain,
        isHighValue: target.isHighValue,
        radarRank: target.radarRank,
        needsBrowser: isDue(target.nextBrowserAt),
        needsRadar: isDue(target.nextRadarAt),
        needsAsync: !target.lastAsyncAt,
      });
    }

    return due
      .filter((item) => item.needsBrowser || item.needsRadar || item.needsAsync)
      .slice(0, safeLimit);
  }

  async getTopByRadarRank(
    limit: number,
    options?: { dueOnly?: boolean },
  ): Promise<Array<{ domain: string; radarRank: number }>> {
    const safeLimit = Math.max(1, Math.trunc(limit));
    const dueOnly = options?.dueOnly ?? false;
    return Array.from(this.targets.values())
      .filter((t) => typeof t.radarRank === 'number' && (!dueOnly || isDue(t.nextTrafficAt)))
      .sort((a, b) => (a.radarRank ?? Infinity) - (b.radarRank ?? Infinity))
      .slice(0, safeLimit)
      .map((t) => ({ domain: t.domain, radarRank: t.radarRank! }));
  }

  async getFastlaneTrafficDomains(
    limit: number,
    options?: { maxSnapshotAgeDays?: number },
  ): Promise<string[]> {
    const safeLimit = Math.max(1, Math.trunc(limit));
    const maxSnapshotAgeDays = Math.max(1, Math.trunc(options?.maxSnapshotAgeDays ?? 30));
    const maxAgeMs = maxSnapshotAgeDays * 86_400_000;
    const nowMs = Date.now();

    return Array.from(this.targets.values())
      .filter((target) => isDue(target.nextTrafficAt))
      .filter((target) => {
        if (!target.lastTrafficAt) {
          return true;
        }

        const lastTrafficAtMs = new Date(target.lastTrafficAt).getTime();
        if (!Number.isFinite(lastTrafficAtMs)) {
          return true;
        }

        return (nowMs - lastTrafficAtMs) >= maxAgeMs;
      })
      .sort((left, right) => {
        const leftRank = left.radarRank ?? Number.POSITIVE_INFINITY;
        const rightRank = right.radarRank ?? Number.POSITIVE_INFINITY;
        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }
        return right.priority - left.priority;
      })
      .slice(0, safeLimit)
      .map((target) => target.domain);
  }

  async getHighRankFirstRunDomains(
    limit: number,
    options?: { maxRadarRank?: number },
  ): Promise<Array<{ domain: string; radarRank: number; isHighValue: boolean }>> {
    const safeLimit = Math.max(1, Math.trunc(limit));
    const maxRadarRank = Math.max(1, Math.trunc(options?.maxRadarRank ?? 100_000));

    return Array.from(this.targets.values())
      .filter((target) => typeof target.radarRank === 'number' && target.radarRank > 0 && target.radarRank <= maxRadarRank)
      .filter((target) => !target.lastBrowserAt && !target.lastBrowserStatus)
      .sort((left, right) => {
        const leftRank = left.radarRank ?? Number.POSITIVE_INFINITY;
        const rightRank = right.radarRank ?? Number.POSITIVE_INFINITY;
        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }
        return right.priority - left.priority;
      })
      .slice(0, safeLimit)
      .map((target) => ({
        domain: target.domain,
        radarRank: target.radarRank!,
        isHighValue: target.isHighValue || target.radarRank! <= 100_000,
      }));
  }

  async claimHighRankFirstRunDomains(
    limit: number,
    options?: { maxRadarRank?: number },
  ): Promise<Array<{ domain: string; radarRank: number; isHighValue: boolean }>> {
    const candidates = await this.getHighRankFirstRunDomains(limit, options);
    const updatedAt = nowIso();

    for (const candidate of candidates) {
      const target = this.targets.get(candidate.domain);
      if (!target || target.lastBrowserStatus || target.lastBrowserAt) {
        continue;
      }
      target.lastBrowserStatus = 'pending';
      target.updatedAt = updatedAt;
      this.targets.set(candidate.domain, target);
    }

    return candidates;
  }

  async releaseClaimedFirstRunDomains(domains: string[]): Promise<void> {
    if (domains.length === 0) {
      return;
    }

    const updatedAt = nowIso();
    for (const domain of domains) {
      const target = this.targets.get(domain);
      if (!target) {
        continue;
      }
      if (target.lastBrowserAt || target.lastBrowserStatus !== 'pending') {
        continue;
      }
      target.lastBrowserStatus = undefined;
      target.updatedAt = updatedAt;
      this.targets.set(domain, target);
    }
  }

  async getBrowserSuccessTaxonomyMissingDomains(
    limit: number,
    options?: { maxRadarRank?: number; currentPromptVersion?: number },
  ): Promise<Array<{ domain: string; radarRank?: number; isHighValue: boolean }>> {
    const safeLimit = Math.max(1, Math.trunc(limit));
    const maxRadarRank = options?.maxRadarRank ? Math.max(1, Math.trunc(options.maxRadarRank)) : null;
    const currentPromptVersion = options?.currentPromptVersion ?? null;

    return Array.from(this.targets.values())
      .filter((target) => target.lastBrowserStatus === 'success')
      .filter((target) => {
        // Case 1: taxonomy missing
        if (!target.taxonomyData) return true;
        // Case 2: prompt version outdated (vision upgrade)
        if (currentPromptVersion && (!target.taxonomyPromptVersion || target.taxonomyPromptVersion < currentPromptVersion)) return true;
        return false;
      })
      .filter((target) => (
        !maxRadarRank
        || (typeof target.radarRank === 'number' && target.radarRank > 0 && target.radarRank <= maxRadarRank)
      ))
      .sort((left, right) => {
        const leftRank = left.radarRank ?? Number.POSITIVE_INFINITY;
        const rightRank = right.radarRank ?? Number.POSITIVE_INFINITY;
        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }
        return right.priority - left.priority;
      })
      .slice(0, safeLimit)
      .map((target) => ({
        domain: target.domain,
        radarRank: target.radarRank,
        isHighValue: target.isHighValue || (typeof target.radarRank === 'number' && target.radarRank <= 100_000),
      }));
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
