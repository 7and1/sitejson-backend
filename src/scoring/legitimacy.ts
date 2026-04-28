import type { SiteReport } from '../core/types.js';

export const calculateLegitimacyScore = (report: SiteReport): { value: number; signals: string[] } => {
  let score = 10;
  const signals: string[] = ['baseline'];

  // DNS signals
  if ((report.dns?.mxRecords?.length ?? 0) > 0) {
    score += 10;
    signals.push('has_mx');
  }

  if ((report.dns?.nsRecords?.length ?? 0) > 0) {
    score += 5;
    signals.push('has_ns');
  }

  // Content structure signals
  if ((report.seo?.h1Count ?? 0) >= 1) {
    score += 5;
    signals.push('has_h1');
  }

  if ((report.seo?.internalLinks ?? 0) >= 5) {
    score += 5;
    signals.push('internal_links');
  }

  if ((report.seo?.imagesCount ?? 0) >= 1) {
    score += 5;
    signals.push('has_images');
  }

  // Meta signals
  if (report.meta?.title) {
    score += 5;
    signals.push('has_title');
  }

  if (report.meta?.description) {
    score += 5;
    signals.push('has_description');
  }

  // Publisher signals
  if (report.publisher?.hasAdsTxt) {
    score += 5;
    signals.push('has_ads_txt');
  }

  // Sitemap directives signal — active sitemap management
  if ((report.files?.robotsSitemapUrls?.length ?? 0) > 0) {
    score += 3;
    signals.push('has_sitemap_directives');
  }

  // Direct ad relationships signal — verified ad partnerships
  if ((report.publisher?.directCount ?? 0) > 0) {
    score += 3;
    signals.push('has_direct_ads');
  }

  // Traffic rank signals
  const globalRank = report.trafficData?.globalRank ?? report.radar?.globalRank;
  if (globalRank != null && globalRank > 0) {
    score += 10;
    signals.push('has_rank');
    if (globalRank < 100_000) {
      score += 5;
      signals.push('rank_top_100k');
    }
    if (globalRank < 10_000) {
      score += 5;
      signals.push('rank_top_10k');
    }
  }

  // Domain age signal
  if ((report.trafficData?.domainAgeYears ?? 0) >= 1) {
    score += 5;
    signals.push('domain_age_1y');
  }

  // Domain expiry signal — domains expiring within 30 days are lower trust
  const expiresAt = report.trafficData?.whois?.expiresAt;
  if (expiresAt) {
    const expiresMs = new Date(expiresAt).getTime();
    if (Number.isFinite(expiresMs)) {
      const daysUntilExpiry = (expiresMs - Date.now()) / (1000 * 60 * 60 * 24);
      if (daysUntilExpiry >= 0 && daysUntilExpiry <= 30) {
        score -= 5;
        signals.push('domain_expires_soon');
      }
    }
  }

  // Domain hold status — clientHold/serverHold are red flags
  const whoisStatus = report.trafficData?.whois?.status;
  if (whoisStatus?.some((s) => /(?:client|server)hold/i.test(s))) {
    score -= 10;
    signals.push('domain_held');
  }

  // AI analysis signals (reduced weight)
  if (report.aiAnalysis?.risk?.sentiment === 'Professional') {
    score += 15;
    signals.push('ai_professional');
  }

  if (report.aiAnalysis?.risk?.isSpam) {
    score -= 30;
    signals.push('spam_signal');
  }

  return {
    value: Math.max(0, Math.min(100, score)),
    signals,
  };
};
