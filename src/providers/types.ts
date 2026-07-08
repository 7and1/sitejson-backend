import { z } from 'zod';

export interface MetaData {
  title: string;
  description: string;
  techStackDetected: string[];
}

export interface SeoData {
  h1Count: number;
  h2Count: number;
  internalLinks: number;
  externalLinks: number;
  imagesCount: number;
}

export interface FilesData {
  hasRobots: boolean;
  hasSitemap: boolean;
  robotsSitemapUrls: string[];
}

export interface DnsData {
  provider: string;
  aRecords: string[];
  aaaaRecords: string[];
  caaRecords: string[];
  mxRecords: string[];
  nsRecords: string[];
  txtRecords: string[];
}

export interface VisualData {
  screenshotUrl?: string;
  screenshotPath?: string;
  dominantColor?: string;
  palette?: string[];
  storage: 'local' | 'r2';
}

export interface AdsData {
  isAdvertiser: boolean;
  advertiserIds: string[];
  advertiserNames: string[];
  resultCount: number;
  transparencySignals: string[];
}

export interface PublisherData {
  hasAdsTxt: boolean;
  adSystems: string[];
  directCount: number;
  resellerCount: number;
  monetizationSignals: string[];
}

export interface AuthorityData {
  domainRating: number | null;
  source: 'ahrefs';
  licenseUrl: string;
  attribution: 'Domain Rating by Ahrefs';
  fetchedAt: string;
}

export type HistoryStatus = 'ready' | 'pending' | 'failed' | 'miss';
export type HistoryVerdict = 'reject' | 'review' | 'watch' | 'likely_clean' | 'no_data';

export interface HistoryTitleSample {
  year: number;
  timestamp: string;
  title: string;
  archiveUrl: string;
}

export interface HistoryData {
  status: HistoryStatus;
  source: 'archiverisk';
  cacheHit: boolean;
  archiveScore: number | null;
  archiveScoreBand: 'clean' | 'watch' | 'review' | 'reject' | 'no_data';
  archiveVerdict: HistoryVerdict;
  label: string;
  language: string;
  sensitiveWords: string[];
  riskFlags: string[];
  firstCaptureYear: number | null;
  lastCaptureYear: number | null;
  historyAgeMonths: number;
  longestStreakYears: number;
  distinctBuildingYears: number;
  recentYearsBuilt: number;
  capturesCount: number;
  yearHistogram: Array<{
    year: number;
    count: number;
  }>;
  titles: HistoryTitleSample[];
  computedAt: string | null;
}

export interface RadarData {
  globalRank: number | null;
  rankBucket?: string;
  categories: string[];
  sourceTimestamp?: string;
  queued: boolean;
}

export interface AiData {
  iabCategory: string;
  iabSubCategory: string;
  confidence: number;
  tags: string[];
  business: {
    summary: string;
    model: string;
    targetAudience: string;
  };
  risk: {
    sentiment: 'Professional' | 'Spammy';
    score: number;
    isSpam: boolean;
  };
  visualAnalysis?: {
    designStyle: string;
    uiScore: number;
    vibe: string;
    logoText?: string;
  };
}

export interface WhoisData {
  registrar: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  updatedAt: string | null;
  nameservers: string[];
  status: string[];
}

export interface WhoisLookupData {
  whois: WhoisData | null;
  domainAgeYears: number | null;
}

export interface TrafficData {
  monthlyVisits: number;
  globalRank: number | null;
  countryRank: number | null;
  bounceRate: number | null;
  avgVisitDuration: number | null;
  pagesPerVisit: number | null;
  dataYear: string | null;
  dataMonth: string | null;
  isStale: boolean | null;
  dataAgeDays: number | null;
  snapshotDate: string | null;
  trafficSources: {
    direct: number;
    search: number;
    social: number;
    referral: number;
    mail: number;
    paid: number;
  } | null;
  topKeywords: Array<{
    keyword: string;
    volume: number;
    cpc: number;
  }>;
  topRegions: Array<{
    countryCode: number;
    country: string;
    share: number;
  }>;
  cachedAt: number | null;
}

export interface ProviderRuntimeOptions {
  timeoutMs?: number;
  retryAttempts?: number;
  retryBaseMs?: number;
}

const metaSchema = z.object({
  title: z.string(),
  description: z.string(),
  techStackDetected: z.array(z.string()),
});

const seoSchema = z.object({
  h1Count: z.number(),
  h2Count: z.number(),
  internalLinks: z.number(),
  externalLinks: z.number(),
  imagesCount: z.number(),
});

const filesSchema = z.object({
  hasRobots: z.boolean(),
  hasSitemap: z.boolean(),
  robotsSitemapUrls: z.array(z.string()),
});

const dnsSchema = z.object({
  provider: z.string(),
  aRecords: z.array(z.string()),
  aaaaRecords: z.array(z.string()),
  caaRecords: z.array(z.string()),
  mxRecords: z.array(z.string()),
  nsRecords: z.array(z.string()),
  txtRecords: z.array(z.string()),
});

const visualSchema = z.object({
  screenshotUrl: z.string().optional(),
  screenshotPath: z.string().optional(),
  dominantColor: z.string().optional(),
  palette: z.array(z.string()).optional(),
  storage: z.enum(['local', 'r2']),
});

const adsSchema = z.object({
  isAdvertiser: z.boolean(),
  advertiserIds: z.array(z.string()),
  advertiserNames: z.array(z.string()),
  resultCount: z.number(),
  transparencySignals: z.array(z.string()),
});

const publisherSchema = z.object({
  hasAdsTxt: z.boolean(),
  adSystems: z.array(z.string()),
  directCount: z.number(),
  resellerCount: z.number(),
  monetizationSignals: z.array(z.string()),
});

const authoritySchema = z.object({
  domainRating: z.number().min(0).max(100).nullable(),
  source: z.literal('ahrefs'),
  licenseUrl: z.string().url(),
  attribution: z.literal('Domain Rating by Ahrefs'),
  fetchedAt: z.string(),
});

const historySchema = z.object({
  status: z.enum(['ready', 'pending', 'failed', 'miss']),
  source: z.literal('archiverisk'),
  cacheHit: z.boolean(),
  archiveScore: z.number().min(0).max(100).nullable(),
  archiveScoreBand: z.enum(['clean', 'watch', 'review', 'reject', 'no_data']),
  archiveVerdict: z.enum(['reject', 'review', 'watch', 'likely_clean', 'no_data']),
  label: z.string(),
  language: z.string(),
  sensitiveWords: z.array(z.string()),
  riskFlags: z.array(z.string()),
  firstCaptureYear: z.number().int().nullable(),
  lastCaptureYear: z.number().int().nullable(),
  historyAgeMonths: z.number().int().min(0),
  longestStreakYears: z.number().int().min(0),
  distinctBuildingYears: z.number().int().min(0),
  recentYearsBuilt: z.number().int().min(0),
  capturesCount: z.number().int().min(0),
  yearHistogram: z.array(z.object({
    year: z.number().int(),
    count: z.number().int().min(0),
  })),
  titles: z.array(z.object({
    year: z.number().int(),
    timestamp: z.string(),
    title: z.string(),
    archiveUrl: z.string().url(),
  })),
  computedAt: z.string().nullable(),
});

const radarSchema = z.object({
  globalRank: z.number().nullable(),
  rankBucket: z.string().optional(),
  categories: z.array(z.string()),
  sourceTimestamp: z.string().optional(),
  queued: z.boolean(),
});

const aiSchema = z.object({
  iabCategory: z.string(),
  iabSubCategory: z.string(),
  confidence: z.number(),
  tags: z.array(z.string()),
  business: z.object({
    summary: z.string(),
    model: z.string(),
    targetAudience: z.string(),
  }),
  risk: z.object({
    sentiment: z.enum(['Professional', 'Spammy']),
    score: z.number(),
    isSpam: z.boolean(),
  }),
  visualAnalysis: z.object({
    designStyle: z.string(),
    uiScore: z.number(),
    vibe: z.string(),
    logoText: z.string().nullable().optional(),
  }).optional(),
});

const whoisSchema = z.object({
  registrar: z.string().nullable(),
  createdAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  nameservers: z.array(z.string()),
  status: z.array(z.string()),
});

const whoisLookupSchema = z.object({
  whois: whoisSchema.nullable(),
  domainAgeYears: z.number().nullable(),
});

const trafficSchema = z.object({
  monthlyVisits: z.number(),
  globalRank: z.number().nullable(),
  countryRank: z.number().nullable(),
  bounceRate: z.number().nullable(),
  avgVisitDuration: z.number().nullable(),
  pagesPerVisit: z.number().nullable(),
  dataYear: z.string().nullable(),
  dataMonth: z.string().nullable(),
  isStale: z.boolean().nullable(),
  dataAgeDays: z.number().nullable(),
  snapshotDate: z.string().nullable(),
  trafficSources: z.object({
    direct: z.number(),
    search: z.number(),
    social: z.number(),
    referral: z.number(),
    mail: z.number(),
    paid: z.number(),
  }).nullable(),
  topKeywords: z.array(z.object({
    keyword: z.string(),
    volume: z.number(),
    cpc: z.number(),
  })),
  topRegions: z.array(z.object({
    countryCode: z.number(),
    country: z.string(),
    share: z.number(),
  })),
  cachedAt: z.number().nullable(),
});

export const parseMetaData = (value: unknown): MetaData | null => {
  const parsed = metaSchema.safeParse(value);
  return parsed.success ? (parsed.data as MetaData) : null;
};

export const parseSeoData = (value: unknown): SeoData | null => {
  const parsed = seoSchema.safeParse(value);
  return parsed.success ? (parsed.data as SeoData) : null;
};

export const parseFilesData = (value: unknown): FilesData | null => {
  const parsed = filesSchema.safeParse(value);
  return parsed.success ? (parsed.data as FilesData) : null;
};

export const parseDnsData = (value: unknown): DnsData | null => {
  const parsed = dnsSchema.safeParse(value);
  return parsed.success ? (parsed.data as DnsData) : null;
};

export const parseVisualData = (value: unknown): VisualData | null => {
  const parsed = visualSchema.safeParse(value);
  return parsed.success ? (parsed.data as VisualData) : null;
};

export const parseAdsData = (value: unknown): AdsData | null => {
  const parsed = adsSchema.safeParse(value);
  return parsed.success ? (parsed.data as AdsData) : null;
};

export const parsePublisherData = (value: unknown): PublisherData | null => {
  const parsed = publisherSchema.safeParse(value);
  return parsed.success ? (parsed.data as PublisherData) : null;
};

export const parseAuthorityData = (value: unknown): AuthorityData | null => {
  const parsed = authoritySchema.safeParse(value);
  return parsed.success ? (parsed.data as AuthorityData) : null;
};

export const parseHistoryData = (value: unknown): HistoryData | null => {
  const parsed = historySchema.safeParse(value);
  return parsed.success ? (parsed.data as HistoryData) : null;
};

export const parseRadarData = (value: unknown): RadarData | null => {
  const parsed = radarSchema.safeParse(value);
  return parsed.success ? (parsed.data as RadarData) : null;
};

export const parseAiData = (value: unknown): AiData | null => {
  const parsed = aiSchema.safeParse(value);
  return parsed.success ? (parsed.data as AiData) : null;
};

export const parseWhoisLookupData = (value: unknown): WhoisLookupData | null => {
  const parsed = whoisLookupSchema.safeParse(value);
  return parsed.success ? (parsed.data as WhoisLookupData) : null;
};

export const parseTrafficData = (value: unknown): TrafficData | null => {
  const parsed = trafficSchema.safeParse(value);
  return parsed.success ? (parsed.data as TrafficData) : null;
};
