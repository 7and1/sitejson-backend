import { describe, expect, it, vi } from 'vitest';
import { PostgresSiteRepository } from '../postgres.js';
import { fakePgPool } from './fake-pg-pool.js';

vi.mock('pg', () => ({
  Pool: class {},
}));

const rows = [
  { slug: 'react', count: '300', top_domain: 'a.com', top_title: 'A' },
  { slug: 'vue', count: '200', top_domain: 'b.com', top_title: 'B' },
  { slug: 'svelte', count: '100', top_domain: 'c.com', top_title: 'C' },
];

describe('PostgresSiteRepository directory type summary', () => {
  it('serves every limit up to the default from one aggregation', async () => {
    const query = vi.fn().mockResolvedValue({ rows });
    const { pool, control } = fakePgPool(query);
    const repo = new PostgresSiteRepository(pool);

    const full = await repo.getDirectoryTypeSummary('technology', 50);
    const top1 = await repo.getDirectoryTypeSummary('technology', 1);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([50]);
    // Runs in its own transaction with the aggregate statement timeout.
    expect(control.map((c) => c.sql)).toEqual(['BEGIN', 'SELECT set_config($1, $2, true)', 'COMMIT']);
    expect(control[1].params).toEqual(['statement_timeout', '600000ms']);
    expect(full.totalSlugs).toBe(3);
    expect(full.totalSites).toBe(600);
    expect(top1).toEqual({
      type: 'technology',
      totalSlugs: 1,
      totalSites: 300,
      slugs: [{ slug: 'react', count: 300, topDomain: 'a.com', topTitle: 'A' }],
    });
  });

  it('reads report_json only for the winning top domains, not in the full scan', async () => {
    const query = vi.fn().mockResolvedValue({ rows });
    const repo = new PostgresSiteRepository(fakePgPool(query).pool);

    await repo.getDirectoryTypeSummary('topic', 50);

    const sql = String(query.mock.calls[0][0]);
    const topDomains = sql.slice(sql.indexOf('top_domains AS'), sql.lastIndexOf('SELECT sc.slug'));
    expect(topDomains).not.toContain('report_json');
    expect(sql).toContain('LEFT JOIN site_profiles sp ON sp.domain = td.domain');
  });
});
