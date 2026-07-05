import { describe, expect, it, vi } from 'vitest';

vi.mock('pg', () => ({
  Pool: class {},
}));

import { PostgresSiteRepository } from '../postgres.js';

describe('PostgresSiteRepository upsert fast path', () => {
  it('uses optimistic update when previousReport is supplied and versions match', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ domain: 'example.com' }] });
    const connect = vi.fn();
    const repo = new PostgresSiteRepository({ query, connect } as any);

    await repo.upsert(
      {
        domain: 'example.com',
        updatedAt: '2026-07-04T00:00:01.000Z',
        meta: { title: 'Updated title' },
      } as any,
      {
        previousReport: {
          domain: 'example.com',
          updatedAt: '2026-07-04T00:00:00.000Z',
          meta: { title: 'Old title' },
        } as any,
      },
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    expect(query.mock.calls[0][0]).toContain('WHERE domain = $1');
    expect(query.mock.calls[0][0]).toContain('AND updated_at = $11');
  });

  it('skips report_json rewrites when only non-authoritative fields changed', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ domain: 'example.com' }] });
    const repo = new PostgresSiteRepository({ query, connect: vi.fn() } as any);

    await repo.upsert(
      {
        domain: 'example.com',
        updatedAt: '2026-07-04T00:05:00.000Z',
      } as any,
      {
        previousReport: {
          domain: 'example.com',
          updatedAt: '2026-07-04T00:00:00.000Z',
          freshnessTtlSec: 120,
          meta: { title: 'Stable title' },
          seo: { h1Count: 1 },
        } as any,
      },
    );

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('SET updated_at = $2');
    expect(sql).not.toContain('report_json = $4::jsonb');
    expect(sql).toContain('AND updated_at = $10');
  });

  it('skips report_json rewrites in the transaction fallback when optimistic update loses the race', async () => {
    const poolQuery = vi.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          domain: 'example.com',
          updated_at: '2026-07-04T00:00:00.000Z',
          freshness_ttl_sec: 120,
          report_json: {
            domain: 'example.com',
            meta: { title: 'Stable title' },
            seo: { h1Count: 1 },
          },
        }],
      })
      .mockResolvedValueOnce({}) // INSERT .. ON CONFLICT DO UPDATE
      .mockResolvedValueOnce({}); // COMMIT
    const repo = new PostgresSiteRepository({
      query: poolQuery,
      connect: vi.fn().mockResolvedValue({
        query: clientQuery,
        release: vi.fn(),
      }),
    } as any);

    await repo.upsert(
      {
        domain: 'example.com',
        updatedAt: '2026-07-04T00:05:00.000Z',
      } as any,
      {
        previousReport: {
          domain: 'example.com',
          updatedAt: '2026-07-04T00:00:00.000Z',
          freshnessTtlSec: 120,
          meta: { title: 'Stable title' },
          seo: { h1Count: 1 },
        } as any,
      },
    );

    const sql = String(clientQuery.mock.calls[2][0]);
    expect(sql).toContain('ON CONFLICT (domain)');
    expect(sql).not.toContain('report_json = EXCLUDED.report_json');
    expect(sql).toContain('freshness_ttl_sec = EXCLUDED.freshness_ttl_sec');
  });
});
