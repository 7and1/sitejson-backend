import type { CrawlContext } from '../core/types.js';
import { providerFailure, providerSuccess } from './base.js';
import type { Provider } from './base.js';
import {
  fetchWithRetry,
  fetchTextViaFlareSolverr,
  fetchTextViaProxyGrid,
  fetchTextViaSoax,
  fetchWithProxyRotation,
  type FlareSolverrFallbackOptions,
  parseProxyList,
  readBoundedText,
  type ProxyGridFallbackOptions,
  type ProxyConfig,
  type SoaxFallbackOptions,
} from './http.js';
import type { TrafficData, ProviderRuntimeOptions } from './types.js';
import { looksBlocked, looksBlockedError, trafficCvHeaders } from './anti-bot.js';

/**
 * Traffic.cv RSC API Parser
 * Endpoint: GET https://traffic.cv/{domain}?_rsc=1
 */
const extractJsonObjectByKey = (text: string, key: string): string | null => {
  const marker = `"${key}":`;
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }

  const start = text.indexOf('{', markerIndex + marker.length);
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
};

const extractJsonArrayByKey = (text: string, key: string): string | null => {
  const marker = `"${key}":`;
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;

  const start = text.indexOf('[', markerIndex + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) { escaped = false; }
      else if (char === '\\') { escaped = true; }
      else if (char === '"') { inString = false; }
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '[') { depth += 1; continue; }
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
};

const parseDurationString = (str: string): number | null => {
  const mMatch = str.match(/(\d+)\s*m/);
  const sMatch = str.match(/([\d.]+)\s*s/);
  if (mMatch || sMatch) {
    const minutes = mMatch ? parseInt(mMatch[1], 10) : 0;
    const seconds = sMatch ? parseFloat(sMatch[1]) : 0;
    return Math.round((minutes * 60 + seconds) * 100) / 100;
  }
  const num = parseFloat(str);
  return Number.isFinite(num) ? num : null;
};

const normalizeBounceRate = (value: number): number | null => {
  if (!Number.isFinite(value)) return null;
  if (value > 0 && value <= 1) return Math.round(value * 100 * 100) / 100;
  return Math.round(value * 100) / 100;
};

const parseRscResponse = (text: string): TrafficRawData | null => {
  const trafficJson = extractJsonObjectByKey(text, 'traffic');
  const whoisJson = extractJsonObjectByKey(text, 'whois');

  if (trafficJson && whoisJson) {
    try {
      return {
        traffic: JSON.parse(trafficJson),
        whois: JSON.parse(whoisJson),
      };
    } catch {
      // fallback
    }
  }

  if (trafficJson) {
    try {
      return {
        traffic: JSON.parse(trafficJson),
      };
    } catch {
      // fallback
    }
  }

  const overview: TrafficOverview = {};

  const visitsMatch = text.match(/"visits":"(\d+)"/);
  if (visitsMatch) overview.visits = visitsMatch[1];

  const globalRankMatch = text.match(/"globalRank":(\d+)/);
  if (globalRankMatch) overview.globalRank = parseInt(globalRankMatch[1], 10);

  const countryRankMatch = text.match(/"countryRank":(\d+)/);
  if (countryRankMatch) overview.countryRank = parseInt(countryRankMatch[1], 10);

  const bounceMatch = text.match(/"bounceRate":"([^"]+)"/);
  if (bounceMatch) overview.bounceRate = bounceMatch[1];

  const timeMatch = text.match(/"timeOnSite":"([^"]+)"/);
  if (timeMatch) overview.timeOnSite = timeMatch[1];

  const pageMatch = text.match(/"pagePerVisit":"([^"]+)"/);
  if (pageMatch) overview.pagePerVisit = pageMatch[1];

  if (!overview.visits && !overview.globalRank) {
    return null;
  }

  let trafficSources: TrafficSources | undefined;
  const sourcesJson = extractJsonObjectByKey(text, 'trafficSources');
  if (sourcesJson) {
    try {
      trafficSources = JSON.parse(sourcesJson);
    } catch {
      // ignore
    }
  }

  let monthlyVisits: Record<string, number> | undefined;
  const monthlyJson = extractJsonObjectByKey(text, 'monthlyVisits');
  if (monthlyJson) {
    try {
      monthlyVisits = JSON.parse(monthlyJson);
    } catch {
      // ignore
    }
  }

  let topKeywords: TrafficKeyword[] | undefined;
  const keywordsJson = extractJsonArrayByKey(text, 'topKeywords');
  if (keywordsJson) {
    try {
      topKeywords = JSON.parse(keywordsJson);
    } catch {
      // ignore
    }
  }

  let topRegions: TrafficRegion[] | undefined;
  const regionsJson = extractJsonArrayByKey(text, 'topRegions');
  if (regionsJson) {
    try {
      topRegions = JSON.parse(regionsJson);
    } catch {
      // ignore
    }
  }

  const registrationEventMatch = text.match(/"eventAction":"registration","eventDate":"([^"]+)"/);
  const whoisFallback = registrationEventMatch
    ? {
      events: [{
        eventAction: 'registration',
        eventDate: registrationEventMatch[1],
      }],
    }
    : undefined;

  return {
    traffic: {
      overview,
      trafficSources,
      monthlyVisits,
      topKeywords,
      topRegions,
    },
    whois: whoisFallback,
  };
};

interface TrafficOverview {
  year?: string;
  month?: string;
  visits?: string;
  bounceRate?: string;
  timeOnSite?: string;
  pagePerVisit?: string;
  globalRank?: number;
  countryRank?: number;
}

interface TrafficSources {
  mail?: number;
  direct?: number;
  search?: number;
  social?: number;
  referrals?: number;
  paidReferrals?: number;
}

interface TrafficKeyword {
  name?: string;
  volume?: number;
  cpc?: number;
  estimatedValue?: number;
}

interface TrafficRegion {
  country?: number;
  name?: string;
  value?: number;
}

interface WhoisRawData {
  objectClassName?: string;
  ldhName?: string;
  status?: string[];
  createdAt?: string;
  expiresAt?: string;
  updatedAt?: string;
  created_at?: string;
  expires_at?: string;
  updated_at?: string;
  events?: Array<{
    eventAction?: string;
    eventDate?: string;
  }>;
  entities?: Array<{
    roles?: string[];
    vcardArray?: [string, Array<[string, Record<string, unknown>, string, string]>];
  }>;
  nameservers?: Array<{
    ldhName?: string;
  }>;
}

interface TrafficRawData {
  locale?: string;
  hostname?: string;
  traffic?: {
    hostname?: string;
    title?: string;
    description?: string;
    cached?: number;
    overview?: TrafficOverview;
    monthlyVisits?: Record<string, number>;
    trafficSources?: TrafficSources;
    topKeywords?: TrafficKeyword[];
    topRegions?: TrafficRegion[];
  };
  whois?: WhoisRawData;
}

interface SimilarwebTrafficSources {
  direct?: number;
  referral?: number;
  referrals?: number;
  search?: number;
  social?: number;
  mail?: number;
  display?: number;
  paid?: number;
  paidReferrals?: number;
  Direct?: number;
  Referral?: number;
  Referrals?: number;
  Search?: number;
  Social?: number;
  Mail?: number;
  Display?: number;
  Paid?: number;
  'Paid Referrals'?: number;
}

interface SimilarwebKeyword {
  keyword?: string;
  name?: string;
  Name?: string;
  volume?: number;
  Volume?: number;
  searchVolume?: number;
  cpc?: number;
  Cpc?: number;
}

interface SimilarwebRegion {
  country?: string;
  Country?: number;
  name?: string;
  countryName?: string;
  CountryCode?: string;
  share?: number;
  value?: number;
  Value?: number;
  countryCode?: number;
  country_code?: number;
  countryId?: number;
}

interface SimilarwebPayload {
  monthly_visits?: number;
  global_rank?: number;
  country_rank?: number;
  bounce_rate?: number;
  pages_per_visit?: number;
  avg_visit_duration?: number;
  snapshot_date?: string;
  traffic_sources?: SimilarwebTrafficSources;
  top_keywords?: SimilarwebKeyword[];
  top_country_shares?: SimilarwebRegion[];
  estimated_monthly_visits?: Record<string, number> | { Value?: number };
  EstimatedMonthlyVisits?: Record<string, number> | { Value?: number };
  GlobalRank?: { Rank?: number | string };
  CountryRank?: { Rank?: number | string };
  Engagments?: {
    BounceRate?: number | string;
    PagePerVisit?: number | string;
    TimeOnSite?: number | string;
    Visits?: number | string;
    Year?: number | string;
    Month?: number | string;
  };
  TrafficSources?: SimilarwebTrafficSources;
  TopKeywords?: SimilarwebKeyword[];
  TopCountryShares?: SimilarwebRegion[];
  raw_data?: {
    EstimatedMonthlyVisits?: Record<string, number> | { Value?: number };
    TrafficSources?: SimilarwebTrafficSources;
    TopKeywords?: SimilarwebKeyword[];
    TopCountryShares?: SimilarwebRegion[];
  };
}

const transformTrafficData = (raw: TrafficRawData): TrafficData => {
  const traffic = raw.traffic;
  const overview = traffic?.overview;
  const sources = traffic?.trafficSources;

  const monthlyVisits = traffic?.monthlyVisits
    ? Object.entries(traffic.monthlyVisits)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, visits]) => ({ month, visits }))
    : [];

  const latestVisits = monthlyVisits.length > 0
    ? monthlyVisits[monthlyVisits.length - 1].visits
    : (overview?.visits ? parseInt(overview.visits, 10) : 0);

  const topKeywords = (traffic?.topKeywords ?? [])
    .slice(0, 5)
    .map((kw) => ({
      keyword: kw.name ?? '',
      volume: kw.volume ?? 0,
      cpc: kw.cpc ?? 0,
    }));

  const topRegions = (traffic?.topRegions ?? [])
    .slice(0, 5)
    .map((region) => ({
      countryCode: region.country ?? 0,
      country: region.name ?? 'Unknown',
      share: region.value ?? 0,
    }));

  return {
    monthlyVisits: latestVisits,
    globalRank: overview?.globalRank ?? null,
    countryRank: overview?.countryRank ?? null,
    bounceRate: overview?.bounceRate ? normalizeBounceRate(parseFloat(overview.bounceRate)) : null,
    avgVisitDuration: overview?.timeOnSite ? parseDurationString(overview.timeOnSite) : null,
    pagesPerVisit: overview?.pagePerVisit ? parseFloat(overview.pagePerVisit) : null,
    dataYear: overview?.year ?? null,
    dataMonth: overview?.month ?? null,
    trafficSources: sources ? {
      direct: sources.direct ?? 0,
      search: sources.search ?? 0,
      social: sources.social ?? 0,
      referral: sources.referrals ?? 0,
      mail: sources.mail ?? 0,
      paid: sources.paidReferrals ?? 0,
    } : null,
    topKeywords,
    topRegions,
    cachedAt: traffic?.cached ?? null,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === 'object' && !Array.isArray(value);
};

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const pickSimilarwebDataCandidate = (value: unknown): SimilarwebPayload | null => {
  if (!isRecord(value)) {
    return null;
  }

  const candidate = value as SimilarwebPayload;
  const hasSignals = Boolean(
    toFiniteNumber(candidate.monthly_visits) !== null
    || toFiniteNumber(candidate.global_rank) !== null
    || toFiniteNumber(candidate.country_rank) !== null
    || isRecord(candidate.estimated_monthly_visits)
    || isRecord(candidate.EstimatedMonthlyVisits)
    || isRecord(candidate.GlobalRank)
    || isRecord(candidate.CountryRank)
    || isRecord(candidate.Engagments)
    || isRecord(candidate.TrafficSources)
    || Array.isArray(candidate.top_keywords)
    || Array.isArray(candidate.TopKeywords)
    || Array.isArray(candidate.TopCountryShares)
    || isRecord(candidate.raw_data),
  );

  return hasSignals ? candidate : null;
};

const extractSimilarwebPayload = (value: unknown): SimilarwebPayload | null => {
  const direct = pickSimilarwebDataCandidate(value);
  if (direct) return direct;

  if (!isRecord(value)) {
    return null;
  }

  const wrapped = pickSimilarwebDataCandidate(value.data);
  if (wrapped) return wrapped;

  const resultWrapped = pickSimilarwebDataCandidate(value.result);
  if (resultWrapped) return resultWrapped;

  return null;
};

const resolveMonthlyVisits = (input: SimilarwebPayload): number => {
  const direct = toFiniteNumber(input.monthly_visits);
  if (direct !== null) {
    return Math.max(0, Math.trunc(direct));
  }

  const fromEstimated = input.estimated_monthly_visits;
  const fromEstimatedPascal = input.EstimatedMonthlyVisits;
  const fromRawEstimated = input.raw_data?.EstimatedMonthlyVisits;
  const candidates = [fromEstimated, fromEstimatedPascal, fromRawEstimated];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(candidate, 'Value')) {
      const value = toFiniteNumber((candidate as { Value?: unknown }).Value);
      if (value !== null) {
        return Math.max(0, Math.trunc(value));
      }
    }

    const datedKeys = Object.keys(candidate)
      .filter((key) => /^\d{4}-\d{2}-\d{2}$/u.test(key))
      .sort((a, b) => a.localeCompare(b));

    if (datedKeys.length === 0) {
      continue;
    }

    const latestKey = datedKeys[datedKeys.length - 1];
    const latestValue = toFiniteNumber((candidate as Record<string, unknown>)[latestKey]);
    if (latestValue !== null) {
      return Math.max(0, Math.trunc(latestValue));
    }
  }

  const fromEngagements = toFiniteNumber(input.Engagments?.Visits);
  if (fromEngagements !== null) {
    return Math.max(0, Math.trunc(fromEngagements));
  }

  return 0;
};

const normalizeSimilarwebSources = (
  sources?: SimilarwebTrafficSources,
): TrafficData['trafficSources'] => {
  const resolved = sources ?? null;
  if (!resolved) {
    return null;
  }

  const direct = toFiniteNumber(resolved.direct ?? resolved.Direct) ?? 0;
  const referral = toFiniteNumber(resolved.referral ?? resolved.referrals ?? resolved.Referral ?? resolved.Referrals) ?? 0;
  const search = toFiniteNumber(resolved.search ?? resolved.Search) ?? 0;
  const social = toFiniteNumber(resolved.social ?? resolved.Social) ?? 0;
  const mail = toFiniteNumber(resolved.mail ?? resolved.Mail) ?? 0;
  const paid = toFiniteNumber(
    resolved.paid
    ?? resolved.display
    ?? resolved.paidReferrals
    ?? resolved.Paid
    ?? resolved.Display
    ?? resolved['Paid Referrals'],
  ) ?? 0;

  return { direct, referral, search, social, mail, paid };
};

const normalizeSimilarwebKeywords = (input: SimilarwebPayload): TrafficData['topKeywords'] => {
  const rawKeywords = input.top_keywords ?? input.raw_data?.TopKeywords ?? input.TopKeywords ?? [];
  return rawKeywords
    .slice(0, 5)
    .map((item) => ({
      keyword: item.keyword ?? item.name ?? item.Name ?? '',
      volume: toFiniteNumber(item.volume ?? item.searchVolume ?? item.Volume) ?? 0,
      cpc: toFiniteNumber(item.cpc ?? item.Cpc) ?? 0,
    }));
};

const normalizeSimilarwebRegions = (input: SimilarwebPayload): TrafficData['topRegions'] => {
  const rawRegions = input.top_country_shares ?? input.raw_data?.TopCountryShares ?? input.TopCountryShares ?? [];
  return rawRegions
    .slice(0, 5)
    .map((item) => ({
      countryCode: Math.trunc(
        toFiniteNumber(item.countryCode ?? item.country_code ?? item.countryId ?? item.Country) ?? 0,
      ),
      country: item.country ?? item.name ?? item.countryName ?? item.CountryCode ?? 'Unknown',
      share: toFiniteNumber(item.share ?? item.value ?? item.Value) ?? 0,
    }));
};

const parseSnapshotYearMonth = (snapshotDate?: string): { year: string | null; month: string | null } => {
  if (!snapshotDate || snapshotDate.trim().length === 0) {
    return { year: null, month: null };
  }

  const normalized = snapshotDate.trim();
  const datePart = normalized.includes('T') ? normalized.split('T')[0] : normalized;
  const match = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) {
    return { year: null, month: null };
  }

  return { year: match[1], month: match[2] };
};

const transformSimilarwebData = (input: SimilarwebPayload): TrafficData => {
  const snapshot = parseSnapshotYearMonth(input.snapshot_date);
  const engagementYear = toFiniteNumber(input.Engagments?.Year);
  const engagementMonth = toFiniteNumber(input.Engagments?.Month);
  const resolvedYear = snapshot.year ?? (engagementYear !== null ? `${Math.trunc(engagementYear)}` : null);
  const resolvedMonth = snapshot.month ?? (
    engagementMonth !== null
      ? `${Math.trunc(engagementMonth)}`.padStart(2, '0')
      : null
  );
  const trafficSources = normalizeSimilarwebSources(
    input.traffic_sources ?? input.raw_data?.TrafficSources ?? input.TrafficSources,
  );

  return {
    monthlyVisits: resolveMonthlyVisits(input),
    globalRank: toFiniteNumber(input.global_rank ?? input.GlobalRank?.Rank),
    countryRank: toFiniteNumber(input.country_rank ?? input.CountryRank?.Rank),
    bounceRate: toFiniteNumber(input.bounce_rate ?? input.Engagments?.BounceRate),
    avgVisitDuration: toFiniteNumber(input.avg_visit_duration ?? input.Engagments?.TimeOnSite),
    pagesPerVisit: toFiniteNumber(input.pages_per_visit ?? input.Engagments?.PagePerVisit),
    dataYear: resolvedYear,
    dataMonth: resolvedMonth,
    trafficSources,
    topKeywords: normalizeSimilarwebKeywords(input),
    topRegions: normalizeSimilarwebRegions(input),
    cachedAt: null,
  };
};

interface TrafficProviderFallbackConfig {
  flareSolverr?: FlareSolverrFallbackOptions;
  proxyGrid?: ProxyGridFallbackOptions;
  soax?: SoaxFallbackOptions;
}

interface TrafficRotationConfig {
  maxPrimaryProxies?: number;
}

interface TrafficSimilarwebConfig {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  maxAgeDays?: number;
  timeoutMs?: number;
}

type TrafficSource = 'similarweb_api' | 'rotation' | 'flaresolverr' | 'proxy_grid' | 'soax';

export class TrafficProvider implements Provider<TrafficData & { source?: TrafficSource }> {
  readonly name = 'traffic.provider';
  private readonly primaryProxies: ProxyConfig[];
  private readonly fallbackProxies: ProxyConfig[];
  private readonly fallback: TrafficProviderFallbackConfig;
  private readonly similarweb?: TrafficSimilarwebConfig;
  private readonly rotation: TrafficRotationConfig;

  constructor(
    private readonly options: ProviderRuntimeOptions,
    proxyList?: string,
    fallbackProxyList?: string,
    fallback?: TrafficProviderFallbackConfig,
    similarweb?: TrafficSimilarwebConfig,
    rotation?: TrafficRotationConfig,
  ) {
    this.primaryProxies = proxyList ? parseProxyList(proxyList) : [];
    this.fallbackProxies = fallbackProxyList ? parseProxyList(fallbackProxyList) : [];
    this.fallback = fallback ?? {};
    this.similarweb = similarweb;
    this.rotation = rotation ?? {};
  }

  private hasSimilarwebConfig(): boolean {
    const apiKey = this.similarweb?.apiKey?.trim();
    return Boolean(
      this.similarweb?.enabled !== false
      && this.similarweb?.baseUrl
      && this.similarweb.baseUrl.trim().length > 0
      && apiKey
      && apiKey.length > 0,
    );
  }

  private buildSimilarwebUrl(domain: string): string {
    const baseUrl = this.similarweb?.baseUrl?.trim().replace(/\/+$/u, '') ?? '';
    const maxAgeDays = Math.max(1, Math.trunc(this.similarweb?.maxAgeDays ?? 30));
    return `${baseUrl}/api/v1/domain/${encodeURIComponent(domain)}?refresh=false&maxAge=${maxAgeDays}`;
  }

  private async fetchFromSimilarwebApi(domain: string): Promise<TrafficData | null> {
    if (!this.hasSimilarwebConfig()) {
      return null;
    }

    const timeoutMs = Math.max(
      1000,
      Math.trunc(this.similarweb?.timeoutMs ?? this.options.timeoutMs ?? 12000),
    );

    const headers: Record<string, string> = {
      accept: 'application/json',
    };
    const apiKey = this.similarweb?.apiKey?.trim();
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }

    const response = await fetchWithRetry(this.buildSimilarwebUrl(domain), {
      timeoutMs,
      retryAttempts: this.options.retryAttempts ?? 2,
      retryBaseMs: this.options.retryBaseMs ?? 500,
      requestInit: {
        headers,
        redirect: 'follow',
      },
    });

    const payload = await response.json() as unknown;
    const extracted = extractSimilarwebPayload(payload);
    if (!extracted) {
      return null;
    }

    const data = transformSimilarwebData(extracted);
    if (data.monthlyVisits <= 0 && data.globalRank === null && data.countryRank === null) {
      return null;
    }

    return data;
  }

  private hasProxyGridSimilarwebConfig(): boolean {
    return Boolean(
      this.fallback.proxyGrid?.baseUrl
      && this.fallback.proxyGrid?.secret,
    );
  }

  private async fetchFromProxyGridSimilarweb(domain: string): Promise<TrafficData | null> {
    if (!this.hasProxyGridSimilarwebConfig()) {
      return null;
    }

    const baseUrl = this.fallback.proxyGrid?.baseUrl?.trim().replace(/\/+$/u, '') ?? '';
    const secret = this.fallback.proxyGrid?.secret?.trim();
    if (!baseUrl || !secret) {
      return null;
    }

    const timeoutMs = Math.max(
      1000,
      Math.trunc(this.similarweb?.timeoutMs ?? this.options.timeoutMs ?? this.fallback.proxyGrid?.timeoutMs ?? 12000),
    );

    const response = await fetchWithRetry(`${baseUrl}/api/search`, {
      timeoutMs,
      retryAttempts: this.options.retryAttempts ?? this.fallback.proxyGrid?.retryAttempts ?? 2,
      retryBaseMs: this.options.retryBaseMs ?? this.fallback.proxyGrid?.retryBaseMs ?? 500,
      requestInit: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-grid-secret': secret,
        },
        body: JSON.stringify({
          type: 'similarweb',
          query: domain,
          force: false,
        }),
      },
    });

    const payload = await response.json() as unknown;
    const extracted = extractSimilarwebPayload(payload);
    if (!extracted) {
      return null;
    }

    const data = transformSimilarwebData(extracted);
    if (data.monthlyVisits <= 0 && data.globalRank === null && data.countryRank === null) {
      return null;
    }

    return data;
  }

  async run(ctx: CrawlContext) {
    const startedAt = Date.now();
    const errors: string[] = [];

    if (this.hasSimilarwebConfig()) {
      try {
        const similarwebData = await this.fetchFromSimilarwebApi(ctx.domain);
        if (similarwebData) {
          return providerSuccess(this.name, startedAt, {
            ...similarwebData,
            source: 'similarweb_api' as const,
          });
        }

        errors.push('similarweb_api_no_data');
      } catch (error) {
        errors.push(error instanceof Error ? `similarweb_api:${error.message}` : 'similarweb_api_failed');
      }
    }

    if (this.hasProxyGridSimilarwebConfig()) {
      try {
        const proxyGridSimilarwebData = await this.fetchFromProxyGridSimilarweb(ctx.domain);
        if (proxyGridSimilarwebData) {
          return providerSuccess(this.name, startedAt, {
            ...proxyGridSimilarwebData,
            source: 'similarweb_api' as const,
          });
        }

        errors.push('proxy_grid_similarweb_no_data');
      } catch (error) {
        errors.push(error instanceof Error ? `proxy_grid_similarweb:${error.message}` : 'proxy_grid_similarweb_failed');
      }
    }

    const url = `https://traffic.cv/${encodeURIComponent(ctx.domain)}?_rsc=1`;
    const timeoutMs = Math.min(this.options.timeoutMs ?? 15000, 5000);
    const retryBaseMs = this.options.retryBaseMs ?? 500;

    const maxPrimaryProxies = Math.max(1, Math.trunc(this.rotation.maxPrimaryProxies ?? 4));

    const parseTrafficText = (text: string): TrafficData | null => {
      const parsed = parseRscResponse(text);
      if (!parsed?.traffic) {
        return null;
      }
      return transformTrafficData(parsed);
    };

    let blocked = false;

    const tryParse = (source: TrafficSource, text: string | null): TrafficData | null => {
      if (!text) {
        errors.push(`${source}_empty`);
        return null;
      }

      if (looksBlocked(200, text)) {
        blocked = true;
        errors.push(`${source}_blocked`);
        return null;
      }

      const data = parseTrafficText(text);
      if (!data) {
        errors.push(`${source}_no_data`);
        return null;
      }

      return data;
    };

    try {
      const response = await fetchWithProxyRotation(url, {
        timeoutMs,
        retryBaseMs,
        requestInit: () => ({
          headers: trafficCvHeaders(ctx.domain),
        }),
        primaryProxies: this.primaryProxies,
        fallbackProxies: this.fallbackProxies,
        maxPrimaryProxies,
      });

      const text = await readBoundedText(response);
      if (looksBlocked(response.status, text)) {
        blocked = true;
        errors.push(`rotation_blocked_${response.status}`);
      }

      const data = tryParse('rotation', text);
      if (data !== null) {
        return providerSuccess(this.name, startedAt, {
          ...data,
          source: 'rotation' as const,
        });
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'rotation_failed');
      blocked = blocked || looksBlockedError(error);
    }

    if (!blocked) {
      return providerFailure(
        this.name,
        startedAt,
        'TRAFFIC_NO_DATA',
        `No traffic data from rotation (non-blocked): ${errors.join(' -> ') || 'unknown'}`,
      );
    }

    const hasFlareSolverr = !!this.fallback.flareSolverr?.baseUrl;
    const hasProxyGrid = !!(this.fallback.proxyGrid?.baseUrl && this.fallback.proxyGrid?.secret);
    const hasSoax = !!(this.fallback.soax?.apiUrl && this.fallback.soax?.secret);
    const hasFallback = hasFlareSolverr || hasProxyGrid || hasSoax;

    if (!hasFallback) {
      return providerFailure(
        this.name,
        startedAt,
        'TRAFFIC_NO_DATA',
        `Rotation blocked and no fallback configured: ${errors.join(' -> ') || 'unknown'}`,
      );
    }

    if (hasFlareSolverr) {
      try {
        const text = await fetchTextViaFlareSolverr(url, {
          timeoutMs,
          retryAttempts: this.options.retryAttempts ?? 2,
          retryBaseMs,
          ...this.fallback.flareSolverr,
        });
        const data = tryParse('flaresolverr', text);
        if (data !== null) {
          return providerSuccess(this.name, startedAt, {
            ...data,
            source: 'flaresolverr' as const,
          });
        }
      } catch (error) {
        errors.push(error instanceof Error ? `flaresolverr:${error.message}` : 'flaresolverr_failed');
      }
    }

    if (hasProxyGrid) {
      try {
        const text = await fetchTextViaProxyGrid(url, {
          timeoutMs,
          retryAttempts: this.options.retryAttempts ?? 2,
          retryBaseMs,
          ...this.fallback.proxyGrid,
        });
        const data = tryParse('proxy_grid', text);
        if (data !== null) {
          return providerSuccess(this.name, startedAt, {
            ...data,
            source: 'proxy_grid' as const,
          });
        }
      } catch (error) {
        errors.push(error instanceof Error ? `proxy_grid:${error.message}` : 'proxy_grid_failed');
      }
    }

    if (hasSoax) {
      try {
        const text = await fetchTextViaSoax(url, {
          timeoutMs,
          retryAttempts: this.options.retryAttempts ?? 2,
          retryBaseMs,
          ...this.fallback.soax,
        });
        const data = tryParse('soax', text);
        if (data !== null) {
          return providerSuccess(this.name, startedAt, {
            ...data,
            source: 'soax' as const,
          });
        }
      } catch (error) {
        errors.push(error instanceof Error ? `soax:${error.message}` : 'soax_failed');
      }
    }

    return providerFailure(
      this.name,
      startedAt,
      'TRAFFIC_NO_DATA',
      `No traffic data from any source: ${errors.join(' -> ') || 'unknown'}`,
    );
  }
}

export { parseRscResponse, extractSimilarwebPayload, transformSimilarwebData };
