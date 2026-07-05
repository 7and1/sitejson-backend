import type { SiteReport } from '../core/types.js';

type TrafficData = NonNullable<SiteReport['trafficData']>;
type WhoisRecord = NonNullable<TrafficData['whois']>;
type ProviderHealthItem = NonNullable<SiteReport['providerHealth']>[number];

const CHALLENGE_TITLE_PATTERNS: RegExp[] = [
  /^just a moment/i,
  /^attention required/i,
  /^access denied/i,
  /^security check/i,
  /^checking your browser/i,
  /^please wait/i,
  /verify(?:ing)? you are (?:a )?human/i,
  /^ddos protection/i,
  /captcha/i,
];

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const normalizeAdSystemToken = (raw: string): string | null => {
  const token = raw.trim().toLowerCase();
  if (!token || /[\s<>"'`]/.test(token)) {
    return null;
  }

  if (token.startsWith('ownerdomain=')) {
    const ownerDomain = token.slice('ownerdomain='.length).trim();
    return DOMAIN_PATTERN.test(ownerDomain) ? ownerDomain : null;
  }

  return DOMAIN_PATTERN.test(token) ? token : null;
};

const isChallengePageTitle = (title?: string | null): boolean => {
  if (!title) return false;
  const trimmed = title.trim();
  if (!trimmed) return false;
  return CHALLENGE_TITLE_PATTERNS.some((pattern) => pattern.test(trimmed));
};

const sanitizeProviderHealth = (value: unknown): ProviderHealthItem[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const byProvider = new Map<string, ProviderHealthItem>();
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const provider = typeof item.provider === 'string' ? item.provider.trim() : '';
    if (!provider) continue;
    if (typeof item.ok !== 'boolean') continue;

    const errorCode = typeof item.errorCode === 'string' && item.errorCode.trim().length > 0
      ? item.errorCode
      : undefined;

    byProvider.set(provider, {
      provider,
      ok: item.ok,
      ...(errorCode ? { errorCode } : {}),
    });
  }

  return Array.from(byProvider.values());
};

const sanitizePublisherAdSystems = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const normalized = normalizeAdSystemToken(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
    if (deduped.length >= 50) break;
  }

  return deduped;
};

const markBlockedProviderHealth = (value: unknown): ProviderHealthItem[] => {
  const byProvider = new Map<string, ProviderHealthItem>();
  for (const item of sanitizeProviderHealth(value) ?? []) {
    byProvider.set(item.provider, item);
  }

  for (const provider of ['meta.provider', 'seo.provider', 'ai.provider']) {
    byProvider.set(provider, {
      provider,
      ok: false,
      errorCode: 'BOT_CHALLENGE_BLOCKED',
    });
  }

  return Array.from(byProvider.values());
};

const stripBlockedCrawlArtifacts = (topLevel: Record<string, unknown>): void => {
  delete topLevel.meta;
  delete topLevel.seo;
  delete topLevel.taxonomy;
  delete topLevel.aiAnalysis;

  const visual = topLevel.visual;
  if (isPlainObject(visual)) {
    const visualPayload = { ...visual };
    delete visualPayload.dominantColor;
    delete visualPayload.palette;
    topLevel.visual = visualPayload;
  }

  const metaPayload = isPlainObject(topLevel._meta) ? { ...topLevel._meta } : {};
  const htmlPayload = isPlainObject(metaPayload.html) ? { ...metaPayload.html } : {};
  delete htmlPayload.primary_h1;
  htmlPayload.length = 0;
  htmlPayload.blocked = true;
  metaPayload.html = htmlPayload;
  topLevel._meta = metaPayload;
  topLevel.providerHealth = markBlockedProviderHealth(topLevel.providerHealth);
};

export const isBlockedSiteReport = (report: SiteReport): boolean => (
  Boolean(report._meta?.html?.blocked) || isChallengePageTitle(report.meta?.title)
);

export const guardBlockedSiteReport = (report: SiteReport): SiteReport => {
  if (!isBlockedSiteReport(report)) {
    return report;
  }

  const topLevel = { ...(report as unknown as Record<string, unknown>) };
  stripBlockedCrawlArtifacts(topLevel);
  return topLevel as unknown as SiteReport;
};

export const sanitizeSiteReport = (report: SiteReport): SiteReport => {
  const topLevel = { ...(report as unknown as Record<string, unknown>) };

  const score = topLevel.score;
  if (isPlainObject(score)) {
    const value = typeof score.value === 'number' && Number.isFinite(score.value)
      ? Math.max(0, Math.min(100, score.value))
      : null;
    const signals = Array.isArray(score.signals)
      ? score.signals.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];

    if (value !== null) {
      topLevel.score = {
        value,
        signals,
      };
    } else {
      delete topLevel.score;
    }
  } else if (score !== undefined) {
    delete topLevel.score;
  }

  const seo = topLevel.seo;
  if (isPlainObject(seo)) {
    const seoPayload = { ...seo };
    delete seoPayload.contacts;
    topLevel.seo = seoPayload;
  }

  const providerHealth = sanitizeProviderHealth(topLevel.providerHealth);
  if (providerHealth) {
    topLevel.providerHealth = providerHealth;
  } else {
    delete topLevel.providerHealth;
  }

  const publisher = topLevel.publisher;
  if (isPlainObject(publisher)) {
    const publisherPayload = { ...publisher };
    const adSystems = sanitizePublisherAdSystems(publisherPayload.adSystems);
    if (adSystems) {
      publisherPayload.adSystems = adSystems;
    } else if (publisherPayload.adSystems !== undefined) {
      delete publisherPayload.adSystems;
    }
    topLevel.publisher = publisherPayload;
  }

  const visual = topLevel.visual;
  if (isPlainObject(visual)) {
    const visualPayload = { ...visual };
    // Internal filesystem path must never be exposed in API output.
    delete visualPayload.screenshotPath;
    topLevel.visual = visualPayload;
  }

  if (isChallengePageTitle(
    isPlainObject(topLevel.meta) && typeof topLevel.meta.title === 'string'
      ? topLevel.meta.title
      : null,
  )) {
    stripBlockedCrawlArtifacts(topLevel);
  }

  return topLevel as unknown as SiteReport;
};

const mergeObject = <T extends object>(previous: T | undefined, next: T | undefined): T | undefined => {
  if (!previous) {
    return next;
  }
  if (!next) {
    return previous;
  }

  return {
    ...previous,
    ...next,
  };
};

const mergeTrafficData = (
  previous: SiteReport['trafficData'],
  next: SiteReport['trafficData'],
): SiteReport['trafficData'] => {
  return mergeObject(previous, next);
};

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.trim().length > 0;
};

const sanitizeStringArray = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.filter((item): item is string => isNonEmptyString(item));
};

const pickStringField = (
  nextValue: string | null | undefined,
  previousValue: string | null | undefined,
): string | null | undefined => {
  if (isNonEmptyString(nextValue)) {
    return nextValue;
  }
  if (isNonEmptyString(previousValue)) {
    return previousValue;
  }
  if (nextValue === null) {
    return previousValue ?? null;
  }
  if (previousValue === null) {
    return null;
  }
  return undefined;
};

const pickArrayField = (
  nextValue: string[] | undefined,
  previousValue: string[] | undefined,
): string[] | undefined => {
  const nextList = sanitizeStringArray(nextValue);
  if (nextList && nextList.length > 0) {
    return nextList;
  }

  const previousList = sanitizeStringArray(previousValue);
  if (previousList && previousList.length > 0) {
    return previousList;
  }

  if (nextList) {
    return [];
  }
  if (previousList) {
    return previousList;
  }
  return undefined;
};

const hasWhoisSignal = (value: WhoisRecord): boolean => {
  return (
    isNonEmptyString(value.registrar)
    || isNonEmptyString(value.createdAt)
    || isNonEmptyString(value.expiresAt)
    || isNonEmptyString(value.updatedAt)
    || (Array.isArray(value.nameservers) && value.nameservers.length > 0)
    || (Array.isArray(value.status) && value.status.length > 0)
    || Object.keys(value).length > 0
  );
};

const mergeWhoisRecord = (
  previous: TrafficData['whois'],
  next: TrafficData['whois'],
): WhoisRecord | undefined => {
  const previousRecord = previous && typeof previous === 'object' ? previous : undefined;
  const nextRecord = next && typeof next === 'object' ? next : undefined;
  if (!previousRecord && !nextRecord) {
    return undefined;
  }

  const merged: WhoisRecord = {
    ...(previousRecord ?? {}),
    ...(nextRecord ?? {}),
    registrar: pickStringField(nextRecord?.registrar, previousRecord?.registrar),
    createdAt: pickStringField(nextRecord?.createdAt, previousRecord?.createdAt),
    expiresAt: pickStringField(nextRecord?.expiresAt, previousRecord?.expiresAt),
    updatedAt: pickStringField(nextRecord?.updatedAt, previousRecord?.updatedAt),
    nameservers: pickArrayField(nextRecord?.nameservers, previousRecord?.nameservers),
    status: pickArrayField(nextRecord?.status, previousRecord?.status),
  };

  return hasWhoisSignal(merged) ? merged : undefined;
};

const mergeWhoisSnapshot = (
  previous: SiteReport['trafficData'],
  next: SiteReport['trafficData'],
): Pick<NonNullable<SiteReport['trafficData']>, 'whois' | 'domainAgeYears'> => {
  const merged: Pick<NonNullable<SiteReport['trafficData']>, 'whois' | 'domainAgeYears'> = {};

  const mergedWhois = mergeWhoisRecord(previous?.whois, next?.whois);
  if (mergedWhois) {
    merged.whois = mergedWhois;
  } else if (previous?.whois !== undefined) {
    merged.whois = previous.whois;
  }

  const hasNextDomainAge = typeof next?.domainAgeYears === 'number' && Number.isFinite(next.domainAgeYears);
  const hasPreviousDomainAge = typeof previous?.domainAgeYears === 'number' && Number.isFinite(previous.domainAgeYears);
  if (hasNextDomainAge) {
    merged.domainAgeYears = next?.domainAgeYears;
  } else if (hasPreviousDomainAge) {
    merged.domainAgeYears = previous?.domainAgeYears;
  }

  return merged;
};

const mergeMeta = (
  previous: SiteReport['_meta'],
  next: SiteReport['_meta'],
): SiteReport['_meta'] => {
  if (!previous) return next;
  if (!next) return previous;

  return {
    ...previous,
    ...next,
    timing: { ...previous.timing, ...next.timing },
    html: { ...previous.html, ...next.html },
    ai: { ...previous.ai, ...next.ai },
    debug: {
      ...previous.debug,
      ...next.debug,
      fallback_path: { ...previous.debug?.fallback_path, ...next.debug?.fallback_path },
    },
  };
};

const mergeProviderHealth = (
  previous: SiteReport['providerHealth'],
  next: SiteReport['providerHealth'],
): SiteReport['providerHealth'] => {
  if (!previous && !next) {
    return undefined;
  }

  const byProvider = new Map<string, ProviderHealthItem>();
  for (const item of previous ?? []) {
    byProvider.set(item.provider, item);
  }
  for (const item of next ?? []) {
    byProvider.set(item.provider, item);
  }

  return Array.from(byProvider.values());
};

export const mergeSiteReports = (previous: SiteReport | null, next: SiteReport): SiteReport => {
  const sanitizedNext = sanitizeSiteReport(next);
  const nextIsBlocked = isBlockedSiteReport(sanitizedNext);
  const effectiveNext = nextIsBlocked ? guardBlockedSiteReport(sanitizedNext) : sanitizedNext;
  if (!previous) {
    return effectiveNext;
  }
  const sanitizedPrevious = sanitizeSiteReport(previous);

  const mergedTrafficData = mergeTrafficData(sanitizedPrevious.trafficData, effectiveNext.trafficData);
  const mergedWhoisSnapshot = mergeWhoisSnapshot(sanitizedPrevious.trafficData, effectiveNext.trafficData);

  return sanitizeSiteReport({
    ...sanitizedPrevious,
    ...effectiveNext,
    updatedAt: effectiveNext.updatedAt,
    freshnessTtlSec: effectiveNext.freshnessTtlSec ?? sanitizedPrevious.freshnessTtlSec,
    visual: nextIsBlocked ? effectiveNext.visual : mergeObject(sanitizedPrevious.visual, effectiveNext.visual),
    meta: nextIsBlocked ? effectiveNext.meta : mergeObject(sanitizedPrevious.meta, effectiveNext.meta),
    seo: nextIsBlocked ? effectiveNext.seo : mergeObject(sanitizedPrevious.seo, effectiveNext.seo),
    files: mergeObject(sanitizedPrevious.files, effectiveNext.files),
    dns: mergeObject(sanitizedPrevious.dns, effectiveNext.dns),
    ads: mergeObject(sanitizedPrevious.ads, effectiveNext.ads),
    publisher: mergeObject(sanitizedPrevious.publisher, effectiveNext.publisher),
    authority: mergeObject(sanitizedPrevious.authority, effectiveNext.authority),
    trafficData: mergedTrafficData
      ? {
          ...mergedTrafficData,
          ...mergedWhoisSnapshot,
        }
      : (Object.keys(mergedWhoisSnapshot).length > 0 ? mergedWhoisSnapshot : undefined),
    radar: mergeObject(sanitizedPrevious.radar, effectiveNext.radar),
    taxonomy: nextIsBlocked ? effectiveNext.taxonomy : mergeObject(sanitizedPrevious.taxonomy, effectiveNext.taxonomy),
    aiAnalysis: nextIsBlocked ? effectiveNext.aiAnalysis : mergeObject(sanitizedPrevious.aiAnalysis, effectiveNext.aiAnalysis),
    providerHealth: mergeProviderHealth(sanitizedPrevious.providerHealth, effectiveNext.providerHealth),
    _meta: mergeMeta(sanitizedPrevious._meta, effectiveNext._meta),
  });
};
