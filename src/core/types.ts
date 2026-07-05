export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

export type TaxonomyTriggerReason = 'force_ai' | 'first_run' | 'hash_changed' | 'prompt_upgrade';

export interface HtmlSignals {
  title: string;
  description: string;
  techStackDetected: string[];
  h1Count: number;
  h2Count: number;
  internalLinks: number;
  externalLinks: number;
  imagesCount: number;
  primaryH1?: string;
  contentLength: number;
}

export interface BrowserPageHandle {
  url(): string;
  content(): Promise<string>;
  screenshot(options?: unknown): Promise<Buffer>;
  evaluate<T>(
    pageFunction: string | ((...args: unknown[]) => T | Promise<T>),
    ...args: unknown[]
  ): Promise<T>;
}

export interface BrowserContext {
  page?: BrowserPageHandle;
  finalUrl?: string;
  screenshotUrl?: string;
  screenshotPath?: string;
  dominantColor?: string;
  palette?: string[];
  screenshotBuffer?: Buffer;
}

export interface CrawlContext {
  domain: string;
  url: string;
  traceId: string;
  startedAt: number;
  phase?: 'ingest' | 'browser' | 'async' | 'radar' | 'traffic' | 'whois';
  html?: string;
  htmlSignals?: HtmlSignals;
  metadata?: {
    contentHash?: string;
    taxonomyCacheHit?: boolean;
    htmlSource?: 'browser' | 'direct' | 'proxy_grid' | 'soax' | 'none';
    unreachable?: boolean;
    blocked?: boolean;
  };
  browser?: BrowserContext;
  options?: {
    forceAi?: boolean;
    skipAi?: boolean;
    forceRefresh?: boolean;
    aiReclassify?: boolean;
    isHighValue?: boolean;
    radarRank?: number;
  };
}

export type JobPriority = 'normal' | 'high';

export interface ProviderResult<T = unknown> {
  provider: string;
  ok: boolean;
  latencyMs: number;
  data: T | null;
  error?: {
    code: string;
    message: string;
  };
}

export interface SiteReport {
  domain: string;
  updatedAt: string;
  freshnessTtlSec?: number;
  score?: {
    value: number;
    signals: string[];
  };
  visual?: {
    screenshotUrl?: string;
    screenshotPath?: string;
    dominantColor?: string;
    palette?: string[];
    storage?: 'local' | 'r2';
  };
  meta?: {
    title?: string;
    description?: string;
    techStackDetected?: string[];
  };
  seo?: {
    h1Count?: number;
    h2Count?: number;
    internalLinks?: number;
    externalLinks?: number;
    imagesCount?: number;
  };
  files?: {
    hasRobots?: boolean;
    hasSitemap?: boolean;
    robotsSitemapUrls?: string[];
  };
  dns?: {
    provider?: string;
    aRecords?: string[];
    aaaaRecords?: string[];
    caaRecords?: string[];
    mxRecords?: string[];
    nsRecords?: string[];
    txtRecords?: string[];
  };
  ads?: {
    isAdvertiser?: boolean;
    advertiserIds?: string[];
    advertiserNames?: string[];
    resultCount?: number;
    transparencySignals?: string[];
  };
  publisher?: {
    hasAdsTxt?: boolean;
    adSystems?: string[];
    directCount?: number;
    resellerCount?: number;
    monetizationSignals?: string[];
  };
  authority?: {
    domainRating?: number | null;
    source?: 'ahrefs';
    licenseUrl?: string;
    attribution?: 'Domain Rating by Ahrefs';
    fetchedAt?: string;
  };
  trafficData?: {
    monthlyVisits?: number;
    globalRank?: number | null;
    countryRank?: number | null;
    bounceRate?: number | null;
    avgVisitDuration?: number | null;
    pagesPerVisit?: number | null;
    dataYear?: string | null;
    dataMonth?: string | null;
    isStale?: boolean | null;
    dataAgeDays?: number | null;
    snapshotDate?: string | null;
    cachedAt?: number | null;
    topCountry?: string;
    topRegions?: Array<{
      countryCode?: number;
      country: string;
      share: number;
    }>;
    topKeywords?: Array<{
      keyword: string;
      volume: number;
      cpc: number;
    }>;
    trafficSources?: {
      direct: number;
      search: number;
      social: number;
      referral: number;
      mail: number;
      paid: number;
    };
    domainAgeYears?: number | null;
    whois?: {
      registrar?: string | null;
      createdAt?: string | null;
      expiresAt?: string | null;
      updatedAt?: string | null;
      nameservers?: string[];
      status?: string[];
    } | null;
  };
  radar?: {
    globalRank?: number | null;
    rankBucket?: string;
    sourceTimestamp?: string;
    categories?: string[];
    queued?: boolean;
  };
  taxonomy?: {
    iabCategory?: string;
    iabSubCategory?: string;
    confidence?: number;
    tags?: string[];
  };
  aiAnalysis?: {
    business?: {
      summary?: string;
      model?: string;
      targetAudience?: string;
    };
    risk?: {
      sentiment?: 'Professional' | 'Spammy';
      score?: number;
      isSpam?: boolean;
    };
    visualAnalysis?: {
      designStyle?: string;
      uiScore?: number;
      vibe?: string;
      logoText?: string;
    };
  };
  providerHealth?: Array<{
    provider: string;
    ok: boolean;
    errorCode?: string;
  }>;
  _meta?: {
    timing?: {
      lane_browser_ms?: number;
      lane_fetch_ms?: number;
      lane_ai_ms?: number;
      total_ms?: number;
    };
    html?: {
      source?: 'browser' | 'direct' | 'proxy_grid' | 'soax' | 'none';
      length?: number;
      primary_h1?: string;
      blocked?: boolean;
    };
    ai?: {
      evaluated?: boolean;
      triggered?: boolean;
      reason?: 'skip_ai' | 'force_ai' | 'auto' | 'disabled' | 'no_signal' | 'spam_guard' | 'ai_provider_missing' | 'no_rank';
    };
    debug?: {
      fallback_path?: {
        browser?: 'browser' | 'direct' | 'proxy_grid' | 'soax' | 'none';
        traffic?: 'similarweb_api' | 'rotation' | 'flaresolverr' | 'proxy_grid' | 'soax' | 'none';
      };
    };
  };
}

export interface CrawlJob {
  id: string;
  domain: string;
  status: JobStatus;
  priority: JobPriority;
  progress: number;
  stage?: string;
  traceId: string;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
}

export type CrawlLayerStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface CrawlTarget {
  domain: string;
  priority: number;
  isHighValue: boolean;
  radarRank?: number;
  lastBrowserAt?: string;
  nextBrowserAt?: string;
  lastBrowserStatus?: CrawlLayerStatus;
  lastAsyncAt?: string;
  lastAsyncStatus?: CrawlLayerStatus;
  lastRadarAt?: string;
  nextRadarAt?: string;
  lastRadarStatus?: CrawlLayerStatus;
  lastTrafficAt?: string;
  nextTrafficAt?: string;
  lastWhoisAt?: string;
  nextWhoisAt?: string;
  taxonomyData?: {
    iabCategory: string;
    iabSubCategory: string;
    confidence: number;
    tags: string[];
  };
  taxonomyUpdatedAt?: string;
  taxonomyModel?: string;
  taxonomyPromptVersion?: number;
  taxonomyLastTriggerReason?: TaxonomyTriggerReason;
  taxonomySourceLane?: 'browser' | 'async';
  lastContentHash?: string;
  createdAt: string;
  updatedAt: string;
  errorCount: number;
  whoisErrorCount: number;
}

export type DirectoryType = 'category' | 'technology' | 'topic';

export interface DirectoryItem {
  domain: string;
  title: string;
  rank?: number;
  description?: string;
  screenshotUrl?: string;
  tags?: string[];
  techStack?: string[];
  monthlyVisits?: number;
  legitimacyScore?: number;
}

export interface DirectorySearchOptions {
  sort?: 'rank' | 'traffic' | 'score';
  minScore?: number;
  hasTraffic?: boolean;
}

export interface DirectorySearchResult {
  items: DirectoryItem[];
  total: number;
}

export interface DirectoryStats {
  type: DirectoryType;
  slug: string;
  total: number;
  avgLegitimacyScore: number | null;
  trafficDistribution: {
    top10k: number;
    top100k: number;
    top1m: number;
    unranked: number;
  };
  topTechnologies: Array<{ name: string; count: number }>;
  topTags: Array<{ name: string; count: number }>;
  topCountries: Array<{ country: string; count: number }>;
  hasTrafficData: number;
}

export interface DirectorySlugSummary {
  slug: string;
  count: number;
  topDomain?: string;
  topTitle?: string;
}

export interface DirectoryTypeSummary {
  type: DirectoryType;
  totalSlugs: number;
  totalSites: number;
  slugs: DirectorySlugSummary[];
}

export interface GlobalInsights {
  totalSites: number;
  withTraffic: number;
  withScore: number;
  scoreDistribution: {
    high: number;
    medium: number;
    low: number;
    unscored: number;
  };
  topCategories: Array<{ slug: string; count: number }>;
  topTechnologies: Array<{ name: string; count: number }>;
  topTopics: Array<{ name: string; count: number }>;
}

export type AlternativesAlgorithm = 'rule_based' | 'semantic_embedding';

export interface AlternativeSiteItem {
  domain: string;
  title: string;
  rank: number;
  score: number;
  reasons: string[];
}

export interface AlternativeSearchResult {
  items: AlternativeSiteItem[];
  algorithm: AlternativesAlgorithm;
}

export interface RadarSnapshot {
  domain: string;
  globalRank: number | null;
  rankBucket?: string;
  categories: string[];
  sourceTimestamp: string;
  updatedAt: string;
}
