import { describe, expect, it, vi } from 'vitest';

vi.mock('pg', () => ({
  Pool: class {},
}));

import { PostgresSiteRepository } from '../postgres.js';

describe('PostgresSiteRepository prewarmDirectoryCaches', () => {
  it('warms first-page directory listings for the hottest slugs of each type', async () => {
    const repo = new PostgresSiteRepository({ query: vi.fn() } as any);

    const getDirectoryTypeSummary = vi.spyOn(repo, 'getDirectoryTypeSummary')
      .mockResolvedValue({
        type: 'category',
        totalSlugs: 1,
        totalSites: 10,
        slugs: [{ slug: 'technology', count: 10 }],
      } as any);
    const getDirectoryStats = vi.spyOn(repo, 'getDirectoryStats').mockResolvedValue({
      type: 'category',
      slug: 'technology',
      total: 10,
      avgLegitimacyScore: 80,
      trafficDistribution: { top10k: 1, top100k: 2, top1m: 3, unranked: 4 },
      topTechnologies: [],
      topTags: [],
      topCountries: [],
      hasTrafficData: 5,
    });
    const searchDirectory = vi.spyOn(repo, 'searchDirectory').mockResolvedValue({
      items: [],
      total: 0,
    });

    await repo.prewarmDirectoryCaches({ topSlugsPerType: 1 });

    expect(getDirectoryTypeSummary).toHaveBeenCalledTimes(3);
    expect(getDirectoryStats).toHaveBeenCalledTimes(3);
    expect(searchDirectory).toHaveBeenCalledTimes(3);
    expect(searchDirectory).toHaveBeenNthCalledWith(1, 'category', 'technology', 1, 24);
  });
});
