import type { SiteReport } from '../core/types.js';

type TrafficData = NonNullable<SiteReport['trafficData']>;
type WhoisRecord = NonNullable<TrafficData['whois']>;
type ProviderHealthItem = NonNullable<SiteReport['providerHealth']>[number];

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

export const sanitizeSiteReport = (report: SiteReport): SiteReport => {
  const topLevel = { ...(report as unknown as Record<string, unknown>) };
  delete topLevel.score;

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
  if (!previous) {
    return sanitizedNext;
  }
  const sanitizedPrevious = sanitizeSiteReport(previous);

  const mergedTrafficData = mergeTrafficData(sanitizedPrevious.trafficData, sanitizedNext.trafficData);
  const mergedWhoisSnapshot = mergeWhoisSnapshot(sanitizedPrevious.trafficData, sanitizedNext.trafficData);

  return sanitizeSiteReport({
    ...sanitizedPrevious,
    ...sanitizedNext,
    updatedAt: sanitizedNext.updatedAt,
    freshnessTtlSec: sanitizedNext.freshnessTtlSec ?? sanitizedPrevious.freshnessTtlSec,
    visual: mergeObject(sanitizedPrevious.visual, sanitizedNext.visual),
    meta: mergeObject(sanitizedPrevious.meta, sanitizedNext.meta),
    seo: mergeObject(sanitizedPrevious.seo, sanitizedNext.seo),
    files: mergeObject(sanitizedPrevious.files, sanitizedNext.files),
    dns: mergeObject(sanitizedPrevious.dns, sanitizedNext.dns),
    ads: mergeObject(sanitizedPrevious.ads, sanitizedNext.ads),
    publisher: mergeObject(sanitizedPrevious.publisher, sanitizedNext.publisher),
    trafficData: mergedTrafficData
      ? {
          ...mergedTrafficData,
          ...mergedWhoisSnapshot,
        }
      : (Object.keys(mergedWhoisSnapshot).length > 0 ? mergedWhoisSnapshot : undefined),
    radar: mergeObject(sanitizedPrevious.radar, sanitizedNext.radar),
    taxonomy: mergeObject(sanitizedPrevious.taxonomy, sanitizedNext.taxonomy),
    aiAnalysis: mergeObject(sanitizedPrevious.aiAnalysis, sanitizedNext.aiAnalysis),
    providerHealth: mergeProviderHealth(sanitizedPrevious.providerHealth, sanitizedNext.providerHealth),
    _meta: mergeMeta(sanitizedPrevious._meta, sanitizedNext._meta),
  });
};
