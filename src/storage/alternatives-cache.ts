import type { AlternativeSearchResult, AlternativeSiteItem } from '../core/types.js';

export const ALTERNATIVES_CACHE_ALGORITHM_VERSION = 'semantic_embedding:v1';
export const ALTERNATIVES_DURABLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const ALTERNATIVES_CACHE_MIN_SEO_QUALITY_SCORE = 0.35;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return value;
};

const parseReasons = (value: unknown): string[] => (
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
);

const parseAlternativeItem = (value: unknown): AlternativeSiteItem | null => {
  if (!isPlainObject(value)) {
    return null;
  }

  const domain = typeof value.domain === 'string' ? value.domain.trim().toLowerCase() : '';
  if (!domain) {
    return null;
  }

  return {
    domain,
    title: typeof value.title === 'string' && value.title.trim() ? value.title.trim() : domain,
    rank: Math.max(0, Math.trunc(toFiniteNumber(value.rank))),
    score: Number.parseFloat(Math.max(0, Math.min(1, toFiniteNumber(value.score))).toFixed(6)),
    reasons: parseReasons(value.reasons),
  };
};

export const computeAlternativesQualityScore = (result: AlternativeSearchResult): number => {
  if (result.items.length === 0) {
    return 0;
  }

  const total = result.items.reduce((sum, item) => sum + Math.max(0, Math.min(1, item.score)), 0);
  return Number.parseFloat((total / result.items.length).toFixed(6));
};

export const parseAlternativesCachePayload = (
  value: unknown,
  limit: number,
): AlternativeSearchResult | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const safeLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
  const items = value
    .map(parseAlternativeItem)
    .filter((item): item is AlternativeSiteItem => Boolean(item))
    .slice(0, safeLimit);

  return {
    algorithm: 'semantic_embedding',
    items,
  };
};

export const createAlternativesCacheExpiry = (now = Date.now()): string =>
  new Date(now + ALTERNATIVES_DURABLE_CACHE_TTL_MS).toISOString();
