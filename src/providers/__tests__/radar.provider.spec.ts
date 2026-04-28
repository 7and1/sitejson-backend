import { describe, expect, it, vi } from 'vitest';
import { RadarProvider } from '../radar.provider.js';

describe('RadarProvider', () => {
  it('returns queued response when snapshot missing', async () => {
    const radarSnapshots = {
      getByDomain: vi.fn(async () => null),
    };

    const radarSyncService = {
      enqueue: vi.fn(async () => undefined),
    };

    const provider = new RadarProvider(radarSnapshots as any, radarSyncService as any, 3600);

    const result = await provider.run({
      domain: 'example.com',
      url: 'https://example.com',
      traceId: 'trc_radar_missing',
      startedAt: Date.now(),
    });

    expect(result.ok).toBe(true);
    expect(result.data?.queued).toBe(true);
    expect(result.data?.globalRank).toBeNull();
    expect(radarSyncService.enqueue).toHaveBeenCalledOnce();
  });

  it('reads fresh snapshot without enqueue', async () => {
    const radarSnapshots = {
      getByDomain: vi.fn(async () => ({
        domain: 'example.com',
        globalRank: 1234,
        rankBucket: 'Top 10k',
        categories: ['Technology'],
        sourceTimestamp: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
    };

    const radarSyncService = {
      enqueue: vi.fn(async () => undefined),
    };

    const provider = new RadarProvider(radarSnapshots as any, radarSyncService as any, 86400);

    const result = await provider.run({
      domain: 'example.com',
      url: 'https://example.com',
      traceId: 'trc_radar_hit',
      startedAt: Date.now(),
    });

    expect(result.ok).toBe(true);
    expect(result.data?.globalRank).toBe(1234);
    expect(result.data?.queued).toBe(false);
    expect(radarSyncService.enqueue).not.toHaveBeenCalled();
  });
});
