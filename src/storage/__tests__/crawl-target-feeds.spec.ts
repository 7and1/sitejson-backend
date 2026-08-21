import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('pg', () => ({
  Pool: class {},
}));

import { InMemoryCrawlTargetRepository } from '../in-memory.js';
import { PostgresCrawlTargetRepository } from '../postgres.js';

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3600_000).toISOString();
const hoursFromNow = (hours: number): string => new Date(Date.now() + hours * 3600_000).toISOString();

describe('CrawlTarget feed selectors', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('defaults first-run selectors to top-1m coverage', async () => {
    const repo = new InMemoryCrawlTargetRepository();

    await repo.bulkUpsert([
      { domain: 'top-100k.com', radarRank: 100_000, priority: 2, isHighValue: true },
      { domain: 'top-1m.com', radarRank: 950_000, priority: 1, isHighValue: false },
      { domain: 'outside-1m.com', radarRank: 1_000_001, priority: 1, isHighValue: false },
    ]);

    const selected = await repo.getHighRankFirstRunDomains(10);

    expect(selected.map((item) => item.domain)).toEqual([
      'top-100k.com',
      'top-1m.com',
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

  it('claims due browser refresh domains once and restores previous status on release', async () => {
    const repo = new InMemoryCrawlTargetRepository();

    await repo.bulkUpsert([
      { domain: 'old-success.com', radarRank: 8, isHighValue: true },
      { domain: 'never-run.com', radarRank: 18, isHighValue: true },
      { domain: 'fresh-success.com', radarRank: 28, isHighValue: true },
      { domain: 'failed-cooling.com', radarRank: 38, isHighValue: true },
      { domain: 'pending.com', radarRank: 48, isHighValue: true },
      { domain: 'outside-rank.com', radarRank: 100_001, isHighValue: true },
    ]);

    await repo.update('old-success.com', {
      lastBrowserStatus: 'success',
      lastBrowserAt: hoursAgo(800),
      nextBrowserAt: hoursAgo(1),
    });
    await repo.update('fresh-success.com', {
      lastBrowserStatus: 'success',
      lastBrowserAt: hoursAgo(10),
      nextBrowserAt: hoursFromNow(10),
    });
    await repo.update('failed-cooling.com', {
      lastBrowserStatus: 'failed',
      nextBrowserAt: hoursFromNow(10),
    });
    await repo.update('pending.com', {
      lastBrowserStatus: 'pending',
    });

    await expect(repo.countDueBrowserRefreshDomains({
      maxRadarRank: 100_000,
      refreshTtlHours: 720,
    })).resolves.toBe(2);

    const claimed = await repo.claimDueBrowserRefreshDomains(10, {
      maxRadarRank: 100_000,
      refreshTtlHours: 720,
    });

    expect(claimed.map((item) => item.domain)).toEqual(['old-success.com', 'never-run.com']);
    expect(claimed[0]).toMatchObject({
      domain: 'old-success.com',
      previousBrowserStatus: 'success',
    });

    await expect(repo.countDueBrowserRefreshDomains({
      maxRadarRank: 100_000,
      refreshTtlHours: 720,
    })).resolves.toBe(0);

    await repo.releaseClaimedBrowserRefreshDomains(claimed);

    await expect(repo.getByDomain('old-success.com')).resolves.toMatchObject({
      lastBrowserStatus: 'success',
    });
    const neverRun = await repo.getByDomain('never-run.com');
    expect(neverRun?.lastBrowserStatus).toBeUndefined();
  });

  it('does not release a browser refresh claim after the worker has completed it', async () => {
    const repo = new InMemoryCrawlTargetRepository();

    await repo.bulkUpsert([
      { domain: 'completed.com', radarRank: 8, isHighValue: true },
    ]);
    await repo.update('completed.com', {
      lastBrowserStatus: 'success',
      lastBrowserAt: hoursAgo(800),
      nextBrowserAt: hoursAgo(1),
    });

    const claimed = await repo.claimDueBrowserRefreshDomains(10, {
      maxRadarRank: 100_000,
      refreshTtlHours: 720,
    });

    await repo.update('completed.com', {
      lastBrowserStatus: 'success',
      lastBrowserAt: new Date().toISOString(),
      nextBrowserAt: hoursFromNow(720),
    });
    await repo.releaseClaimedBrowserRefreshDomains(claimed);

    await expect(repo.getByDomain('completed.com')).resolves.toMatchObject({
      lastBrowserStatus: 'success',
    });
  });

  it('stratifies a full SimilarWeb seed across Radar rank cohorts', async () => {
    const repo = new InMemoryCrawlTargetRepository();
    await repo.bulkUpsert([
      ...[1, 2, 3].map((radarRank) => ({ domain: `top-${radarRank}.example`, radarRank })),
      ...[1_001, 1_002, 1_003, 1_004].map((radarRank) => ({ domain: `upper-${radarRank}.example`, radarRank })),
      ...[10_001, 10_002, 10_003, 10_004].map((radarRank) => ({ domain: `mid-${radarRank}.example`, radarRank })),
      ...[100_001, 100_002, 100_003].map((radarRank) => ({ domain: `long-${radarRank}.example`, radarRank })),
      { domain: 'outside-radar.example', radarRank: 1_000_001 },
    ]);

    const selected = await repo.getSimilarwebCollectSeedDomains(10, {
      maxSnapshotAgeDays: 30,
    });

    expect(selected.map((item) => item.radarRank)).toEqual([
      1,
      2,
      1_001,
      1_002,
      1_003,
      10_001,
      10_002,
      10_003,
      100_001,
      100_002,
    ]);
  });

  it('backfills an undersupplied cohort by global Radar rank without excluding hard domains', async () => {
    const repo = new InMemoryCrawlTargetRepository();
    await repo.bulkUpsert([
      { domain: 'hard-top.example', radarRank: 1 },
      ...[1_001, 1_002, 1_003, 1_004, 1_005].map((radarRank) => ({ domain: `upper-${radarRank}.example`, radarRank })),
      ...[10_001, 10_002, 10_003].map((radarRank) => ({ domain: `mid-${radarRank}.example`, radarRank })),
      ...[100_001, 100_002].map((radarRank) => ({ domain: `long-${radarRank}.example`, radarRank })),
    ]);
    await repo.update('hard-top.example', { errorCount: 99 });

    const selected = await repo.getSimilarwebCollectSeedDomains(10, {
      maxSnapshotAgeDays: 30,
    });

    expect(selected.map((item) => item.radarRank)).toEqual([
      1,
      1_001,
      1_002,
      1_003,
      1_004,
      10_001,
      10_002,
      10_003,
      100_001,
      100_002,
    ]);
    expect(selected.map((item) => item.domain)).toContain('hard-top.example');
  });

  it('uses update age and domain as deterministic tie-breakers inside a cohort', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T00:00:00.000Z'));
    const repo = new InMemoryCrawlTargetRepository();
    await repo.bulkUpsert([
      { domain: 'old-z.example', radarRank: 10 },
      { domain: 'old-y.example', radarRank: 10 },
    ]);

    vi.setSystemTime(new Date('2026-08-19T01:00:00.000Z'));
    await repo.bulkUpsert([
      { domain: 'new-a.example', radarRank: 10 },
      ...[1_001, 1_002, 1_003].map((radarRank) => ({ domain: `upper-${radarRank}.example`, radarRank })),
      ...[10_001, 10_002, 10_003].map((radarRank) => ({ domain: `mid-${radarRank}.example`, radarRank })),
      ...[100_001, 100_002].map((radarRank) => ({ domain: `long-${radarRank}.example`, radarRank })),
    ]);

    const selected = await repo.getSimilarwebCollectSeedDomains(10);
    const selectedDomains = selected.map((item) => item.domain);

    expect(selectedDomains).toContain('old-y.example');
    expect(selectedDomains).toContain('old-z.example');
    expect(selectedDomains).not.toContain('new-a.example');
  });

  it('keeps the production selector profile-gated, stratified, and capped at ten', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repo = new PostgresCrawlTargetRepository({ query } as any);

    await repo.getSimilarwebCollectSeedDomains(80, { maxSnapshotAgeDays: 30 });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain('INNER JOIN site_profiles');
    expect(String(sql)).toContain('eligible AS NOT MATERIALIZED');
    expect(String(sql)).toContain('radar_rank BETWEEN 100001 AND 1000000');
    expect(String(sql)).toContain('ct.radar_rank BETWEEN 1 AND 1000000');
    expect(String(sql)).not.toContain('error_count');
    expect(params).toEqual([10, 30, 2, 3, 3, 2]);
  });
});
