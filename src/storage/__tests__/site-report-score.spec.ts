import { describe, expect, it, vi } from 'vitest';

vi.mock('pg', () => ({
  Pool: class {},
}));

import { InMemorySiteRepository } from '../in-memory.js';
import { PostgresSiteRepository } from '../postgres.js';

describe('site report score persistence', () => {
  it('adds a calculated score when reading from the in-memory repository', async () => {
    const repo = new InMemorySiteRepository();

    await repo.upsert({
      domain: 'example.com',
      updatedAt: '2026-07-04T00:00:00.000Z',
      meta: { title: 'Example', description: 'Example description' },
      seo: { h1Count: 1, internalLinks: 8, imagesCount: 2 },
      dns: { mxRecords: ['mx1.example.com'] },
    } as any);

    const report = await repo.getByDomain('example.com');

    expect(report?.score).toEqual(expect.objectContaining({
      value: expect.any(Number),
      signals: expect.arrayContaining(['baseline', 'has_mx', 'has_h1']),
    }));
  });

  it('stores a calculated score in postgres upsert payloads', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ domain: 'example.com' }] });
    const repo = new PostgresSiteRepository({ query, connect: vi.fn() } as any);

    await repo.upsert({
      domain: 'example.com',
      updatedAt: '2026-07-04T00:00:01.000Z',
      meta: { title: 'Updated title', description: 'Updated description' },
      seo: { h1Count: 1, internalLinks: 5, imagesCount: 1 },
      dns: { mxRecords: ['mx.example.com'] },
    } as any, {
      previousReport: {
        domain: 'example.com',
        updatedAt: '2026-07-04T00:00:00.000Z',
        meta: { title: 'Old title' },
      } as any,
    });

    const persistedJson = query.mock.calls[0]?.[1]?.[3] as string;
    const persistedReport = JSON.parse(persistedJson);

    expect(persistedReport.score).toEqual(expect.objectContaining({
      value: expect.any(Number),
      signals: expect.arrayContaining(['baseline', 'has_mx', 'has_h1']),
    }));
  });

  it('backfills score for legacy postgres rows that do not already store it', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        domain: 'example.com',
        updated_at: '2026-07-04T00:00:01.000Z',
        freshness_ttl_sec: null,
        report_json: {
          domain: 'example.com',
          updatedAt: '2026-07-04T00:00:01.000Z',
          meta: { title: 'Example', description: 'Example description' },
          seo: { h1Count: 1, internalLinks: 6, imagesCount: 1 },
          dns: { mxRecords: ['mx.example.com'] },
        },
      }],
    });
    const repo = new PostgresSiteRepository({ query } as any);

    const report = await repo.getByDomain('example.com');

    expect(report?.score).toEqual(expect.objectContaining({
      value: expect.any(Number),
      signals: expect.arrayContaining(['baseline', 'has_mx', 'has_h1']),
    }));
  });
});
