import { describe, expect, it, vi } from 'vitest';
import { buildSiteReportResponse } from '../site-report-response.js';

const makeReport = () => ({
  domain: 'example.com',
  updatedAt: '2026-07-04T00:10:00.000Z',
  freshnessTtlSec: 3600,
});

const makeCrawlTarget = () => ({
  domain: 'example.com',
  priority: 1,
  isHighValue: false,
  radarRank: null,
  lastBrowserAt: '2026-07-04T00:09:00.000Z',
  nextBrowserAt: null,
  lastBrowserStatus: 'success',
  lastAsyncAt: null,
  lastAsyncStatus: null,
  lastRadarAt: null,
  nextRadarAt: null,
  lastRadarStatus: null,
  lastTrafficAt: null,
  nextTrafficAt: null,
  lastWhoisAt: null,
  nextWhoisAt: null,
  taxonomyData: null,
  taxonomyUpdatedAt: null,
  taxonomyModel: null,
  taxonomyPromptVersion: null,
  taxonomyLastTriggerReason: null,
  taxonomySourceLane: null,
  lastContentHash: null,
  createdAt: '2026-07-04T00:00:00.000Z',
  updatedAt: '2026-07-04T00:09:00.000Z',
  errorCount: 0,
  whoisErrorCount: 0,
});

describe('buildSiteReportResponse', () => {
  it('uses a preloaded crawlTarget without calling the repository again', async () => {
    const getByDomain = vi.fn();
    const result = await buildSiteReportResponse({
      crawlTarget: makeCrawlTarget() as any,
      crawlTargets: { getByDomain } as any,
    }, makeReport() as any, Date.parse('2026-07-04T00:10:30.000Z'));

    expect(getByDomain).not.toHaveBeenCalled();
    expect(result.data.enrichment.pending).toBe(true);
    expect(result.data.enrichment.pending_layers).toContain('traffic');
    expect(result.data.enrichment.pending_layers).toContain('whois');
  });

  it('falls back to crawlTargets.getByDomain when no preloaded target is supplied', async () => {
    const getByDomain = vi.fn().mockResolvedValue(makeCrawlTarget());

    await buildSiteReportResponse({
      crawlTargets: { getByDomain } as any,
    }, makeReport() as any, Date.parse('2026-07-04T00:10:30.000Z'));

    expect(getByDomain).toHaveBeenCalledWith('example.com');
  });
});
