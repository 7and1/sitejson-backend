import type {
  AlternativeSearchResult,
  CrawlJob,
  CrawlTarget,
  DirectorySearchOptions,
  DirectorySearchResult,
  DirectoryStats,
  DirectoryType,
  DirectoryTypeSummary,
  GlobalInsights,
  RadarSnapshot,
  SiteReport,
  TaxonomyTriggerReason,
} from '../core/types.js';

export interface BrowserRefreshClaim {
  domain: string;
  radarRank: number;
  isHighValue: boolean;
  previousBrowserStatus?: CrawlTarget['lastBrowserStatus'];
}

export interface TaxonomyData {
  iabCategory: string;
  iabSubCategory: string;
  confidence: number;
  tags: string[];
}

export interface DashboardJobStats {
  createdTotal: number;
  running: number;
  completed: number;
  failed: number;
  successRate: number;
  avgE2eSeconds: number;
  trafficCoverage: number;
}

export interface DashboardRecentJobItem {
  jobId: string;
  domain: string;
  status: CrawlJob['status'];
  priority: CrawlJob['priority'];
  stage?: string;
  rank: number | null;
  updatedAt: string;
  errorMessage?: string;
}

export interface CrawlTargetScheduleDue {
  domain: string;
  isHighValue: boolean;
  radarRank?: number;
  needsBrowser: boolean;
  needsRadar: boolean;
  needsAsync: boolean;
}

export interface CrawlTargetUpdatePatch {
  priority?: number;
  isHighValue?: boolean;
  radarRank?: number;
  lastBrowserAt?: string;
  nextBrowserAt?: string;
  lastBrowserStatus?: CrawlTarget['lastBrowserStatus'];
  lastAsyncAt?: string;
  lastAsyncStatus?: CrawlTarget['lastAsyncStatus'];
  lastRadarAt?: string;
  nextRadarAt?: string;
  lastRadarStatus?: CrawlTarget['lastRadarStatus'];
  lastTrafficAt?: string;
  nextTrafficAt?: string;
  lastWhoisAt?: string;
  nextWhoisAt?: string;
  taxonomyData?: TaxonomyData;
  taxonomyUpdatedAt?: string;
  taxonomyModel?: string;
  taxonomyPromptVersion?: number;
  taxonomyLastTriggerReason?: TaxonomyTriggerReason;
  taxonomySourceLane?: 'browser' | 'async';
  lastContentHash?: string | null;
  errorCount?: number;
  whoisErrorCount?: number;
}

export interface TrafficRefreshOptions {
  forceRefresh?: boolean;
  now?: Date;
  startDay?: number;
  spreadDays?: number;
}

export interface SiteUpsertOptions {
  previousReport?: SiteReport | null;
}

export interface SiteRepository {
  getByDomain(domain: string): Promise<SiteReport | null>;
  upsert(report: SiteReport, options?: SiteUpsertOptions): Promise<void>;
  searchDirectory(type: DirectoryType, slug: string, page: number, pageSize: number, options?: DirectorySearchOptions): Promise<DirectorySearchResult>;
  getDirectoryStats(type: DirectoryType, slug: string): Promise<DirectoryStats>;
  getDirectoryTypeSummary(type: DirectoryType, limit?: number): Promise<DirectoryTypeSummary>;
  getGlobalInsights(): Promise<GlobalInsights>;
  findAlternatives(domain: string, limit: number): Promise<AlternativeSearchResult | null>;
  healthCheck(): Promise<boolean>;
  /**
   * Best-effort warming of the directory facet/stats caches on startup, so the
   * first requests after a (re)deploy don't all run the slow aggregations at
   * once (which would otherwise produce a cold-start burst of timeouts).
   */
  prewarmDirectoryCaches(options?: { topSlugsPerType?: number }): Promise<void>;
}

export interface RadarSnapshotRepository {
  getByDomain(domain: string): Promise<RadarSnapshot | null>;
  upsert(snapshot: RadarSnapshot): Promise<void>;
  bulkUpsert(snapshots: RadarSnapshot[]): Promise<void>;
  healthCheck(): Promise<boolean>;
}

export interface JobRepository {
  create(job: CrawlJob): Promise<void>;
  createPendingIfAbsent(job: CrawlJob): Promise<{ created: boolean; existingJobId?: string }>;
  getById(id: string): Promise<CrawlJob | null>;
  update(job: CrawlJob): Promise<void>;
  markRunning(jobId: string, stage: string, progress?: number): Promise<void>;
  markCompleted(jobId: string, stage?: string, progress?: number): Promise<void>;
  markFailed(jobId: string, errorMessage: string, stage?: string): Promise<void>;
  findRunningByDomain(domain: string): Promise<CrawlJob | null>;
  getDashboardJobStats(windowMs: number): Promise<DashboardJobStats>;
  getRecentDashboardJobs(windowMs: number, limit: number): Promise<DashboardRecentJobItem[]>;
  releaseStaleActiveJobs(options?: { staleHours?: number; limit?: number }): Promise<number>;
  healthCheck(): Promise<boolean>;
}

export interface CrawlTargetRepository {
  upsert(domain: string, options?: { priority?: number; isHighValue?: boolean }): Promise<CrawlTarget>;
  getByDomain(domain: string): Promise<CrawlTarget | null>;
  getExistingDomains(domains: string[]): Promise<Set<string>>;
  bulkUpsert(
    items: Array<{
      domain: string;
      priority?: number;
      isHighValue?: boolean;
      radarRank?: number;
    }>,
  ): Promise<void>;
  bulkUpdateRadarRank(items: Array<{ domain: string; radarRank: number }>): Promise<void>;
  markLayerResult(
    domain: string,
    layer: 'browser' | 'async' | 'radar',
    status: CrawlTarget['lastBrowserStatus'],
    options?: { ttlSec?: number; errorBackoffSec?: number },
  ): Promise<void>;
  update(domain: string, patch: CrawlTargetUpdatePatch): Promise<void>;
  evaluateDue(domain: string, options?: TrafficRefreshOptions): Promise<CrawlTargetScheduleDue>;
  getDueBatch(limit: number, options?: TrafficRefreshOptions): Promise<CrawlTargetScheduleDue[]>;
  getTopByRadarRank(
    limit: number,
    options?: { dueOnly?: boolean; maxRadarRank?: number },
  ): Promise<Array<{ domain: string; radarRank: number }>>;
  getFastlaneTrafficDomains(
    limit: number,
    options?: { maxSnapshotAgeDays?: number },
  ): Promise<string[]>;
  getSimilarwebCollectSeedDomains(
    limit: number,
    options?: { maxSnapshotAgeDays?: number },
  ): Promise<Array<{ domain: string; radarRank?: number }>>;
  getHighRankFirstRunDomains(
    limit: number,
    options?: { maxRadarRank?: number },
  ): Promise<Array<{ domain: string; radarRank: number; isHighValue: boolean }>>;
  claimHighRankFirstRunDomains(
    limit: number,
    options?: { maxRadarRank?: number },
  ): Promise<Array<{ domain: string; radarRank: number; isHighValue: boolean }>>;
  releaseClaimedFirstRunDomains(domains: string[]): Promise<void>;
  countDueBrowserRefreshDomains(
    options?: { maxRadarRank?: number; refreshTtlHours?: number },
  ): Promise<number>;
  claimDueBrowserRefreshDomains(
    limit: number,
    options?: { maxRadarRank?: number; refreshTtlHours?: number },
  ): Promise<BrowserRefreshClaim[]>;
  releaseClaimedBrowserRefreshDomains(claims: BrowserRefreshClaim[]): Promise<void>;
  releaseStaleBrowserPending(
    options?: { staleHours?: number; limit?: number; maxRadarRank?: number },
  ): Promise<number>;
  getBrowserSuccessTaxonomyMissingDomains(
    limit: number,
    options?: { maxRadarRank?: number; currentPromptVersion?: number },
  ): Promise<Array<{ domain: string; radarRank?: number; isHighValue: boolean }>>;
  healthCheck(): Promise<boolean>;
}
