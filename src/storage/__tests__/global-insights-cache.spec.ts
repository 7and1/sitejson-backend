import { describe, expect, it, vi } from 'vitest';
import { PostgresSiteRepository } from '../postgres.js';

vi.mock('pg', () => ({
  Pool: class {},
}));

const row = {
  total_sites: '100',
  with_traffic: '40',
  with_score: '90',
  score_high: '50',
  score_medium: '30',
  score_low: '10',
  score_unscored: '10',
  top_categories: [{ slug: 'news', count: '20' }],
  top_technologies: [{ name: 'react', count: '15' }],
  top_topics: [{ name: 'ai', count: '5' }],
};

describe('PostgresSiteRepository global insights cache', () => {
  it('runs one aggregation for concurrent cold requests', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const repo = new PostgresSiteRepository({ query } as any);

    const results = await Promise.all([repo.getGlobalInsights(), repo.getGlobalInsights(), repo.getGlobalInsights()]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(results[0].totalSites).toBe(100);
    expect(results[2].topTechnologies).toEqual([{ name: 'react', count: 15 }]);
  });

  it('reads a warm persisted value instead of querying after a restart', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
    };

    await new PostgresSiteRepository({ query } as any, { cacheRedis: redis }).getGlobalInsights();
    await Promise.resolve();
    expect(store.has('sj:insights:global')).toBe(true);

    const restarted = new PostgresSiteRepository({ query } as any, { cacheRedis: redis });
    expect((await restarted.getGlobalInsights()).totalSites).toBe(100);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
