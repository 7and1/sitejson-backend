import type { SiteReport } from '../core/types.js';

const normalizeTxtRecord = (value: string): string => (
  value
    .trim()
    .replace(/^"+|"+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
);

const getEmailAuthSignals = (report: SiteReport): {
  hasSpf: boolean;
  hasDmarc: boolean;
  hasDkim: boolean;
} => {
  const txtRecords = (report.dns?.txtRecords ?? []).map(normalizeTxtRecord);

  return {
    hasSpf: txtRecords.some((record) => record.startsWith('v=spf1')),
    hasDmarc: txtRecords.some((record) => record.startsWith('v=dmarc1')),
    hasDkim: txtRecords.some((record) => record.startsWith('v=dkim1')),
  };
};

const countAiCorroborationSignals = (report: SiteReport): number => {
  let count = 0;
  const emailAuth = getEmailAuthSignals(report);

  if ((report.dns?.aRecords?.length ?? 0) > 0 || (report.dns?.aaaaRecords?.length ?? 0) > 0) count += 1;
  if ((report.dns?.caaRecords?.length ?? 0) > 0) count += 1;
  if ((report.dns?.mxRecords?.length ?? 0) > 0) count += 1;
  if ((report.dns?.nsRecords?.length ?? 0) > 0) count += 1;
  if (emailAuth.hasSpf) count += 1;
  if (emailAuth.hasDmarc) count += 1;
  if (emailAuth.hasDkim) count += 1;
  if ((report.files?.robotsSitemapUrls?.length ?? 0) > 0) count += 1;
  if ((report.publisher?.directCount ?? 0) > 0) count += 1;
  if ((report.trafficData?.domainAgeYears ?? 0) >= 1) count += 1;

  const globalRank = report.trafficData?.globalRank ?? report.radar?.globalRank;
  if (globalRank != null && globalRank > 0) count += 1;

  if (typeof report.authority?.domainRating === 'number' && report.authority.domainRating >= 30) {
    count += 1;
  }

  return count;
};

const hasHistoryAbuseFlag = (riskFlags: string[]): boolean => (
  riskFlags.includes('gambling_history')
  || riskFlags.includes('adult_history')
  || riskFlags.includes('pharma_spam')
);

export const calculateLegitimacyScore = (report: SiteReport): { value: number; signals: string[] } => {
  let score = 10;
  const signals: string[] = ['baseline'];
  const emailAuth = getEmailAuthSignals(report);

  // DNS signals
  if ((report.dns?.aRecords?.length ?? 0) > 0 || (report.dns?.aaaaRecords?.length ?? 0) > 0) {
    score += 3;
    signals.push('has_address_records');
  }

  if ((report.dns?.caaRecords?.length ?? 0) > 0) {
    score += 2;
    signals.push('has_caa');
  }

  if ((report.dns?.mxRecords?.length ?? 0) > 0) {
    score += 10;
    signals.push('has_mx');
  }

  if ((report.dns?.nsRecords?.length ?? 0) > 0) {
    score += 5;
    signals.push('has_ns');
  }

  if (emailAuth.hasSpf) {
    score += 3;
    signals.push('has_spf');
  }

  if (emailAuth.hasDmarc) {
    score += 4;
    signals.push('has_dmarc');
  }

  if (emailAuth.hasDkim) {
    score += 3;
    signals.push('has_dkim');
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

  if (report.history?.status === 'ready' && report.history.capturesCount >= 5) {
    if (report.history.longestStreakYears >= 5) {
      score += 4;
      signals.push('history_long_lived');
    }

    if (report.history.longestStreakYears >= 10) {
      score += 3;
      signals.push('history_very_long_lived');
    }

    if (report.history.historyAgeMonths >= 36) {
      score += 3;
      signals.push('history_established');
    }

    if (hasHistoryAbuseFlag(report.history.riskFlags)) {
      score -= 12;
      signals.push('history_prior_abuse');
    }

    if (report.history.riskFlags.includes('recent_pollution')) {
      score -= 8;
      signals.push('history_recent_pollution');
    }

    if (report.history.riskFlags.includes('parking_only')) {
      score -= 5;
      signals.push('history_parking_only');
    }

    if (report.history.riskFlags.includes('theme_drift')) {
      score -= 3;
      signals.push('history_theme_drift');
    }
  }

  const aiCorroborationSignals = countAiCorroborationSignals(report);

  // AI analysis signals are capped and require corroboration from non-AI signals.
  if (report.aiAnalysis?.risk?.sentiment === 'Professional') {
    if (aiCorroborationSignals >= 2) {
      score += 6;
      signals.push('ai_professional');
    } else {
      signals.push('ai_professional_unconfirmed');
    }
  }

  if (report.aiAnalysis?.risk?.isSpam) {
    if (aiCorroborationSignals >= 1) {
      score -= 10;
      signals.push('spam_signal');
    } else {
      signals.push('spam_signal_unconfirmed');
    }
  }

  return {
    value: Math.max(0, Math.min(100, score)),
    signals,
  };
};

export const withCalculatedLegitimacyScore = (report: SiteReport): SiteReport => ({
  ...report,
  score: calculateLegitimacyScore(report),
});
