import { describe, expect, it, vi } from 'vitest';
import { PostgresSiteRepository } from '../postgres.js';

vi.mock('pg', () => ({
  Pool: class {},
}));

describe('PostgresSiteRepository directory listing cache', () => {
  it('reuses cached stats totals for unfiltered directory listings instead of COUNT(*) OVER()', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          domain: 'example.com',
          title: 'Example',
          description: 'Example description',
          tech_stack: ['React'],
          screenshot_url: 'https://cdn.example.com/example.webp',
          tags: ['saas'],
          monthly_visits: '120000',
          rank_int: 1500,
          traffic_rank_int: 2000,
          legitimacy_score_int: 87,
        },
      ],
    });

    const repo = new PostgresSiteRepository({ query } as any);
    const statsSpy = vi.spyOn(repo, 'getDirectoryStats').mockResolvedValue({
      type: 'technology',
      slug: 'react',
      total: 42,
      avgLegitimacyScore: 80,
      trafficDistribution: { top10k: 1, top100k: 2, top1m: 3, unranked: 36 },
      topTechnologies: [],
      topTags: [],
      topCountries: [],
      hasTrafficData: 10,
    });

    const result = await repo.searchDirectory('technology', 'react', 1, 24, { sort: 'rank' });

    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).not.toContain('COUNT(*) OVER()');
    expect(statsSpy).toHaveBeenCalledWith('technology', 'react');
    expect(result.total).toBe(42);

    // The page is picked by sort key alone; report_json is read only for the
    // joined page rows, never in the filtered scan.
    const sql = String(query.mock.calls[0][0]);
    const pageSubquery = sql.slice(sql.indexOf('FROM ('), sql.indexOf(') page'));
    expect(pageSubquery).toContain('ORDER BY COALESCE(rank_int, 999999999) ASC');
    expect(pageSubquery).not.toContain('report_json');
    expect(sql).toContain('JOIN site_profiles sp ON sp.domain = page.domain');
  });

  it('single-flights repeated searchDirectory calls for the same key', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          domain: 'example.com',
          title: 'Example',
          description: 'Example description',
          tech_stack: ['React'],
          screenshot_url: 'https://cdn.example.com/example.webp',
          tags: ['saas'],
          monthly_visits: '120000',
          rank_int: 1500,
          traffic_rank_int: 2000,
          legitimacy_score_int: 87,
          total_count: '1',
        },
      ],
    });

    const repo = new PostgresSiteRepository({ query } as any);
    vi.spyOn(repo, 'getDirectoryStats').mockResolvedValue({
      type: 'technology',
      slug: 'react',
      total: 1,
      avgLegitimacyScore: 87,
      trafficDistribution: { top10k: 1, top100k: 0, top1m: 0, unranked: 0 },
      topTechnologies: [],
      topTags: [],
      topCountries: [],
      hasTrafficData: 1,
    });

    const first = await repo.searchDirectory('technology', 'react', 1, 24, { sort: 'rank' });
    const second = await repo.searchDirectory('technology', 'react', 1, 24, { sort: 'rank' });

    expect(query).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.total).toBe(1);
    expect(first.items[0]?.domain).toBe('example.com');
  });

  it('treats different filter/sort combinations as separate cache keys', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const repo = new PostgresSiteRepository({ query } as any);
    vi.spyOn(repo, 'getDirectoryStats').mockResolvedValue({
      type: 'technology',
      slug: 'react',
      total: 0,
      avgLegitimacyScore: 0,
      trafficDistribution: { top10k: 0, top100k: 0, top1m: 0, unranked: 0 },
      topTechnologies: [],
      topTags: [],
      topCountries: [],
      hasTrafficData: 0,
    });

    await repo.searchDirectory('technology', 'react', 1, 24, { sort: 'rank' });
    await repo.searchDirectory('technology', 'react', 1, 24, { sort: 'score' });

    expect(query).toHaveBeenCalledTimes(2);
  });

  it('uses a dedicated count query for filtered listings instead of COUNT(*) OVER()', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });
    const repo = new PostgresSiteRepository({ query } as any);

    const result = await repo.searchDirectory('technology', 'react', 1, 24, { sort: 'rank', hasTraffic: true });

    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0][0])).not.toContain('COUNT(*) OVER()');
    expect(String(query.mock.calls[1][0])).toContain('SELECT COUNT(*)::text AS count');
    expect(result.total).toBe(0);
  });
});
