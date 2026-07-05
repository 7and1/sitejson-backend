import { describe, expect, it, vi } from 'vitest';

vi.mock('pg', () => ({
  Pool: class {},
}));

import { PostgresCrawlTargetRepository } from '../postgres.js';

const makeRow = () => ({
  domain: 'example.com',
  priority: 1,
  is_high_value: false,
  radar_rank: null,
  last_browser_at: null,
  next_browser_at: null,
  last_browser_status: null,
  last_async_at: null,
  last_async_status: null,
  last_radar_at: null,
  next_radar_at: null,
  last_radar_status: null,
  last_traffic_at: null,
  next_traffic_at: null,
  last_whois_at: null,
  next_whois_at: null,
  taxonomy_data: null,
  taxonomy_updated_at: null,
  taxonomy_model: null,
  taxonomy_prompt_version: null,
  taxonomy_last_trigger_reason: null,
  taxonomy_source_lane: null,
  last_content_hash: null,
  created_at: '2026-07-04T00:00:00.000Z',
  updated_at: '2026-07-04T00:00:00.000Z',
  error_count: 0,
  whois_error_count: 0,
});

describe('PostgresCrawlTargetRepository write path', () => {
  it('evaluateDue reads existing targets without an upsert write', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [makeRow()],
    });
    const repo = new PostgresCrawlTargetRepository({ query } as any);

    await repo.evaluateDue('example.com');

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('SELECT *');
    expect(query.mock.calls[0][0]).not.toContain('INSERT INTO crawl_targets');
  });

  it('markLayerResult updates existing targets without a pre-upsert write', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [],
      });
    const repo = new PostgresCrawlTargetRepository({ query } as any);

    await repo.markLayerResult('example.com', 'browser', 'success');

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('UPDATE crawl_targets');
    expect(query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO crawl_targets'))).toBe(false);
  });

  it('markLayerResult inserts missing targets only after an update miss', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const repo = new PostgresCrawlTargetRepository({ query } as any);

    await repo.markLayerResult('example.com', 'browser', 'success');

    expect(query).toHaveBeenCalledTimes(3);
    expect(String(query.mock.calls[0][0])).toContain('UPDATE crawl_targets');
    expect(String(query.mock.calls[1][0])).toContain('INSERT INTO crawl_targets');
    expect(String(query.mock.calls[2][0])).toContain('UPDATE crawl_targets');
  });

  it('update patches existing targets without a pre-read', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const repo = new PostgresCrawlTargetRepository({ query } as any);

    await repo.update('example.com', { lastTrafficAt: '2026-07-04T00:00:00.000Z' });

    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).toContain('UPDATE crawl_targets');
    expect(String(query.mock.calls[0][0])).not.toContain('SELECT *');
  });
});
