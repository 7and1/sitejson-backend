import { describe, expect, it } from 'vitest';
import { InMemoryCrawlTargetRepository } from '../in-memory.js';

describe('CrawlTarget feed selectors', () => {
  it('selects only high-rank first-run domains for ingest auto-feed', async () => {
    const repo = new InMemoryCrawlTargetRepository();

    await repo.bulkUpsert([
      { domain: 'first-run-top.com', radarRank: 10, priority: 10, isHighValue: true },
      { domain: 'first-run-mid.com', radarRank: 200, priority: 5, isHighValue: false },
      { domain: 'already-success.com', radarRank: 12, priority: 10, isHighValue: true },
      { domain: 'already-failed.com', radarRank: 15, priority: 10, isHighValue: true },
      { domain: 'too-low-rank.com', radarRank: 200_000, priority: 10, isHighValue: false },
    ]);

    await repo.update('already-success.com', {
      lastBrowserStatus: 'success',
      lastBrowserAt: new Date().toISOString(),
    });
    await repo.update('already-failed.com', {
      lastBrowserStatus: 'failed',
    });

    const selected = await repo.getHighRankFirstRunDomains(10, {
      maxRadarRank: 100_000,
    });

    expect(selected.map((item) => item.domain)).toEqual([
      'first-run-top.com',
      'first-run-mid.com',
    ]);
  });

  it('selects browser-success taxonomy-missing domains for ai retry', async () => {
    const repo = new InMemoryCrawlTargetRepository();

    await repo.bulkUpsert([
      { domain: 'missing-taxonomy-a.com', radarRank: 5, isHighValue: true },
      { domain: 'missing-taxonomy-b.com', radarRank: 30, isHighValue: false },
      { domain: 'has-taxonomy.com', radarRank: 7, isHighValue: true },
      { domain: 'browser-failed.com', radarRank: 3, isHighValue: true },
    ]);

    await repo.update('missing-taxonomy-a.com', {
      lastBrowserStatus: 'success',
      lastBrowserAt: new Date().toISOString(),
    });
    await repo.update('missing-taxonomy-b.com', {
      lastBrowserStatus: 'success',
      lastBrowserAt: new Date().toISOString(),
    });
    await repo.update('has-taxonomy.com', {
      lastBrowserStatus: 'success',
      lastBrowserAt: new Date().toISOString(),
      taxonomyData: {
        iabCategory: 'Technology & Computing',
        iabSubCategory: 'Software',
        confidence: 0.9,
        tags: ['saas'],
      },
    });
    await repo.update('browser-failed.com', {
      lastBrowserStatus: 'failed',
    });

    const selected = await repo.getBrowserSuccessTaxonomyMissingDomains(10, {
      maxRadarRank: 100_000,
    });

    expect(selected.map((item) => item.domain)).toEqual([
      'missing-taxonomy-a.com',
      'missing-taxonomy-b.com',
    ]);
  });

  it('claims first-run domains once and supports release on enqueue failure', async () => {
    const repo = new InMemoryCrawlTargetRepository();

    await repo.bulkUpsert([
      { domain: 'claim-a.com', radarRank: 8, isHighValue: true },
      { domain: 'claim-b.com', radarRank: 18, isHighValue: true },
    ]);

    const claimed = await repo.claimHighRankFirstRunDomains(10, {
      maxRadarRank: 100_000,
    });
    expect(claimed.map((item) => item.domain)).toEqual(['claim-a.com', 'claim-b.com']);

    const secondPass = await repo.getHighRankFirstRunDomains(10, {
      maxRadarRank: 100_000,
    });
    expect(secondPass).toEqual([]);

    await repo.releaseClaimedFirstRunDomains(['claim-b.com']);

    const released = await repo.getHighRankFirstRunDomains(10, {
      maxRadarRank: 100_000,
    });
    expect(released.map((item) => item.domain)).toEqual(['claim-b.com']);
  });
});
