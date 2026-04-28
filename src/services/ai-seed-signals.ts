import type { HtmlSignals, SiteReport } from '../core/types.js';

const normalizeText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeCount = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.trunc(value));
};

const normalizeTechStack = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const cleaned = value
    .map((item) => normalizeText(item))
    .filter((item): item is string => !!item);

  return Array.from(new Set(cleaned));
};

/**
 * Build AI seed signals from a previous site report.
 * Shared by AsyncWorker and BrowserWorker to avoid duplication.
 */
export function buildAiSeedSignals(
  domain: string,
  previous: SiteReport | null | undefined,
): HtmlSignals | undefined {
  if (!previous) {
    return undefined;
  }

  const title = normalizeText(previous.meta?.title) ?? '';
  const description = normalizeText(previous.meta?.description) ?? '';
  const techStackDetected = normalizeTechStack(previous.meta?.techStackDetected);
  const h1Count = normalizeCount(previous.seo?.h1Count);
  const h2Count = normalizeCount(previous.seo?.h2Count);
  const internalLinks = normalizeCount(previous.seo?.internalLinks);
  const externalLinks = normalizeCount(previous.seo?.externalLinks);
  const imagesCount = normalizeCount(previous.seo?.imagesCount);
  const primaryH1 = normalizeText(previous._meta?.html?.primary_h1);
  const contentLength = normalizeCount(previous._meta?.html?.length);

  const hasSignal = title.length > 0
    || description.length > 0
    || techStackDetected.length > 0
    || h1Count > 0
    || h2Count > 0
    || internalLinks > 0
    || externalLinks > 0
    || imagesCount > 0
    || !!primaryH1
    || contentLength > 0;

  if (!hasSignal) {
    return undefined;
  }

  return {
    title: title || domain,
    description,
    techStackDetected,
    h1Count,
    h2Count,
    internalLinks,
    externalLinks,
    imagesCount,
    primaryH1,
    contentLength,
  };
}
