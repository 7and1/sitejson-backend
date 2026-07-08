import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveHistoryProvider } from '../history.provider.js';

const providerOptions = {
  timeoutMs: 100,
  retryAttempts: 0,
  retryBaseMs: 1,
};

const createContext = () => ({
  domain: 'example.com',
  url: 'https://example.com',
  traceId: 'trc_history',
  startedAt: Date.now(),
});

describe('ArchiveHistoryProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps a cached ArchiveRisk lookup into SiteJSON history data and truncates titles', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: {
          history: {
            domain: 'example.com',
            status: 'ready',
            score: 82,
            scoreBand: 'clean',
            verdict: 'likely_clean',
            label: 'Real business',
            language: 'English',
            sensitiveWords: [],
            riskFlags: ['real_business'],
            metrics: {
              firstCaptureYear: 2012,
              lastCaptureYear: 2026,
              historyAgeMonths: 120,
              longestStreakYears: 10,
              distinctBuildingYears: 8,
              recentYearsBuilt: 5,
              yearHistogram: [{ year: 2026, count: 2 }],
            },
            titles: [
              {
                year: 2026,
                timestamp: '20260101120000',
                title: 'Example One',
                archiveUrl: 'https://web.archive.org/web/20260101120000/https://example.com',
              },
              {
                year: 2025,
                timestamp: '20250101120000',
                title: 'Example Two',
                archiveUrl: 'https://web.archive.org/web/20250101120000/https://example.com',
              },
            ],
            capturesCount: 14,
            computedAt: '2026-07-06T00:00:00.000Z',
          },
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const provider = new ArchiveHistoryProvider({
      enabled: true,
      baseUrl: 'http://archiverisk-web:3000',
      computeOnMiss: false,
      maxTitles: 1,
      timeoutMs: 1000,
    }, providerOptions);

    const result = await provider.run(createContext());

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      status: 'ready',
      source: 'archiverisk',
      cacheHit: true,
      archiveScore: 82,
      archiveVerdict: 'likely_clean',
      label: 'Real business',
      capturesCount: 14,
    });
    expect(result.data?.titles).toHaveLength(1);
    expect(result.data?.titles[0]?.title).toBe('Example One');
  });

  it('returns a miss payload when ArchiveRisk has no cached history', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: {
          history: null,
          state: 'miss',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const provider = new ArchiveHistoryProvider({
      enabled: true,
      baseUrl: 'http://archiverisk-web:3000',
      computeOnMiss: false,
      maxTitles: 12,
      timeoutMs: 1000,
    }, providerOptions);

    const result = await provider.run(createContext());

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe('miss');
    expect(result.data?.archiveVerdict).toBe('no_data');
  });

  it('computes on miss with x-api-key and maps the computed history', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          ok: true,
          data: {
            history: null,
            state: 'miss',
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          ok: true,
          data: {
            history: {
              domain: 'example.com',
              status: 'ready',
              score: 51,
              scoreBand: 'watch',
              verdict: 'watch',
              label: 'Content site',
              language: 'English',
              sensitiveWords: [],
              riskFlags: [],
              metrics: {
                firstCaptureYear: 2020,
                lastCaptureYear: 2026,
                historyAgeMonths: 48,
                longestStreakYears: 4,
                distinctBuildingYears: 4,
                recentYearsBuilt: 3,
                yearHistogram: [{ year: 2026, count: 1 }],
              },
              titles: [],
              capturesCount: 6,
              computedAt: '2026-07-06T00:00:00.000Z',
              cacheHit: false,
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const provider = new ArchiveHistoryProvider({
      enabled: true,
      baseUrl: 'http://archiverisk-web:3000',
      apiKey: 'internal-archive-key',
      computeOnMiss: true,
      maxTitles: 12,
      timeoutMs: 1000,
    }, providerOptions);

    const result = await provider.run(createContext());

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe('ready');
    expect(result.data?.cacheHit).toBe(false);
    expect(fetchSpy.mock.calls).toHaveLength(2);
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('http://archiverisk-web:3000/api/lookup/example.com/compute');
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'x-api-key': 'internal-archive-key',
      }),
    });
  });

  it('maps transport failures to providerHealth-friendly error codes', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('HTTP_429'));

    const provider = new ArchiveHistoryProvider({
      enabled: true,
      baseUrl: 'http://archiverisk-web:3000',
      computeOnMiss: false,
      maxTitles: 12,
      timeoutMs: 1000,
    }, providerOptions);

    const result = await provider.run(createContext());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ARCHIVE_HISTORY_RATE_LIMITED');
  });
});
