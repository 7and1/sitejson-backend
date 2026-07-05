import { describe, expect, it, vi, beforeEach } from 'vitest';

const { fetchWithRetry } = vi.hoisted(() => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock('../../providers/http.js', () => ({
  fetchWithRetry,
}));

import { TrafficHistoryService } from '../traffic-history-service.js';

describe('TrafficHistoryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps similarweb history payloads into the SiteJSON shape', async () => {
    fetchWithRetry.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        ok: true,
        data: {
          domain: 'example.com',
          total_snapshots: 2,
          pagination: { limit: 12, offset: 0, has_more: false },
          snapshots: [
            {
              snapshot_date: '2026-06-01',
              monthly_visits: 120000,
              monthly_visits_change: 0.12,
              global_rank: 1500,
              country_rank: 120,
              category_rank: 44,
              bounce_rate: 51.2,
              pages_per_visit: 3.2,
              avg_visit_duration: 210,
              data_source: 'similarweb-api',
              created_at: '2026-06-10T00:00:00Z',
            },
          ],
        },
      }),
    });

    const service = new TrafficHistoryService({
      enabled: true,
      baseUrl: 'https://similarweb-api.example.com',
      apiKey: 'sw-key',
      timeoutMs: 1000,
      retryAttempts: 0,
      retryBaseMs: 1,
    });

    const result = await service.getHistory('example.com');

    expect(fetchWithRetry).toHaveBeenCalledWith(
      'https://similarweb-api.example.com/api/v1/domain/example.com/history?limit=12&offset=0',
      expect.objectContaining({
        requestInit: {
          headers: {
            accept: 'application/json',
            'x-api-key': 'sw-key',
          },
        },
      }),
    );
    expect(result).toEqual({
      domain: 'example.com',
      totalSnapshots: 2,
      pagination: {
        limit: 12,
        offset: 0,
        hasMore: false,
      },
      snapshots: [
        {
          snapshotDate: '2026-06-01',
          monthlyVisits: 120000,
          monthlyVisitsChange: 0.12,
          globalRank: 1500,
          countryRank: 120,
          categoryRank: 44,
          bounceRate: 51.2,
          pagesPerVisit: 3.2,
          avgVisitDuration: 210,
          dataSource: 'similarweb-api',
          collectedAt: '2026-06-10T00:00:00Z',
        },
      ],
    });
  });

  it('returns null when history is not configured or not found', async () => {
    const unconfigured = new TrafficHistoryService({});
    await expect(unconfigured.getHistory('example.com')).resolves.toBeNull();

    fetchWithRetry.mockResolvedValueOnce({
      status: 404,
      json: async () => ({}),
    });
    const configured = new TrafficHistoryService({
      enabled: true,
      baseUrl: 'https://similarweb-api.example.com',
      apiKey: 'sw-key',
    });
    await expect(configured.getHistory('example.com')).resolves.toBeNull();
  });
});
