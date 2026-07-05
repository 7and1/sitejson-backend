import type { CrawlTargetRepository } from '../storage/interfaces.js';
import type { CrawlTarget, SiteReport } from '../core/types.js';
import { guardBlockedSiteReport, sanitizeSiteReport } from './report-merge.js';
import { withCalculatedLegitimacyScore } from '../scoring/legitimacy.js';

export type SiteEnrichmentLayer = 'async_ai' | 'traffic' | 'whois';

export type SiteEnrichmentStatus = {
  pending: boolean;
  pending_layers: SiteEnrichmentLayer[];
};

export type SiteReportResponseDependencies = {
  crawlTargets?: CrawlTargetRepository;
  crawlTarget?: CrawlTarget | null;
};

const ENRICHMENT_PENDING_WINDOW_MS = 10 * 60_000;
const ASYNC_NON_PENDING_TERMINAL_STATUSES = new Set<CrawlTarget['lastAsyncStatus']>(['failed', 'skipped']);

export const emptyEnrichment = (): SiteEnrichmentStatus => ({
  pending: false,
  pending_layers: [],
});

const timestampAtOrAfter = (value: string | undefined, referenceMs: number): boolean => {
  if (!value) {
    return false;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= referenceMs;
};

export const deriveEnrichmentStatus = (
  target: CrawlTarget | null,
  isStale: boolean,
  now = Date.now(),
): SiteEnrichmentStatus => {
  if (isStale || !target || target.lastBrowserStatus !== 'success' || !target.lastBrowserAt) {
    return emptyEnrichment();
  }

  const browserAtMs = Date.parse(target.lastBrowserAt);
  if (!Number.isFinite(browserAtMs) || now - browserAtMs > ENRICHMENT_PENDING_WINDOW_MS) {
    return emptyEnrichment();
  }

  const pendingLayers: SiteEnrichmentLayer[] = [];
  const asyncTerminal = ASYNC_NON_PENDING_TERMINAL_STATUSES.has(target.lastAsyncStatus);
  const asyncCaughtUp = timestampAtOrAfter(target.lastAsyncAt, browserAtMs);
  const taxonomyCaughtUp = timestampAtOrAfter(target.taxonomyUpdatedAt, browserAtMs);

  if (!asyncTerminal && (!asyncCaughtUp || !taxonomyCaughtUp)) {
    pendingLayers.push('async_ai');
  }
  if (!timestampAtOrAfter(target.lastTrafficAt, browserAtMs)) {
    pendingLayers.push('traffic');
  }
  if (!timestampAtOrAfter(target.lastWhoisAt, browserAtMs)) {
    pendingLayers.push('whois');
  }

  return {
    pending: pendingLayers.length > 0,
    pending_layers: pendingLayers,
  };
};

export const buildSiteReportResponse = async (
  deps: SiteReportResponseDependencies,
  report: SiteReport,
  now = Date.now(),
) => {
  const sanitizedReport = guardBlockedSiteReport(sanitizeSiteReport(report));
  const responseReport = withCalculatedLegitimacyScore(sanitizedReport);
  const ttlSec = report.freshnessTtlSec ?? 604800;
  const updatedAtMs = new Date(report.updatedAt).getTime();
  const isStale = !Number.isFinite(updatedAtMs) || now - updatedAtMs > ttlSec * 1000;
  const hasPreloadedTarget = Object.prototype.hasOwnProperty.call(deps, 'crawlTarget');
  const target = hasPreloadedTarget
    ? deps.crawlTarget ?? null
    : deps.crawlTargets
      ? await deps.crawlTargets.getByDomain(report.domain)
      : null;
  const enrichment = deriveEnrichmentStatus(target, isStale, now);

  return {
    sanitizedReport,
    data: {
      domain: report.domain,
      status: 'completed' as const,
      freshness: {
        is_stale: isStale,
        updated_at: report.updatedAt,
      },
      enrichment,
      report: responseReport,
    },
  };
};
