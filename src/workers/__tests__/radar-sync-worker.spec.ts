import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../observability/logger.js';
import { RadarSyncWorker } from '../radar-sync-worker.js';

describe('RadarSyncWorker batch processing', () => {
  it('uses bulk repositories and enqueues only new domains', async () => {
    const radarSnapshots = {
      getByDomain: vi.fn(),
      upsert: vi.fn(),
      bulkUpsert: vi.fn(),
      healthCheck: vi.fn(),
    };

    const crawlTargets = {
      upsert: vi.fn(),
      getByDomain: vi.fn(),
      getExistingDomains: vi.fn().mockResolvedValue(new Set(['existing.com'])),
      bulkUpsert: vi.fn(),
      bulkUpdateRadarRank: vi.fn(),
      markLayerResult: vi.fn(),
      update: vi.fn(),
      evaluateDue: vi.fn(),
      getDueBatch: vi.fn(),
      getTopByRadarRank: vi.fn(),
      healthCheck: vi.fn(),
    };

    const jobs = {
      create: vi.fn(),
      createPendingIfAbsent: vi.fn(),
      getById: vi.fn(),
      update: vi.fn(),
      markRunning: vi.fn(),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
      findRunningByDomain: vi.fn(),
      getDashboardJobStats: vi.fn(),
      getRecentDashboardJobs: vi.fn(),
      healthCheck: vi.fn(),
    };

    const queue = {
      enqueue: vi.fn(),
      enqueueBulk: vi.fn(),
      addRepeatable: vi.fn(),
      consume: vi.fn(),
      getCounts: vi.fn(),
      getAllCounts: vi.fn(),
      retryFailed: vi.fn(),
      healthCheck: vi.fn(),
    };

    const worker = new RadarSyncWorker(
      radarSnapshots as any,
      crawlTargets as any,
      jobs as any,
      queue as any,
      createLogger('error'),
      'token',
      'ranking_bucket',
      100,
      0,
      1,
      10000,
    );

    const newCount = await (worker as any).processBatch([
      { domain: 'new.com', rank: 1200 },
      { domain: 'existing.com', rank: 1800 },
      { domain: 'new.com', rank: 1200 },
    ], 'trc_radar');

    expect(newCount).toBe(1);
    expect(crawlTargets.getExistingDomains).toHaveBeenCalledWith(['new.com', 'existing.com']);
    expect(crawlTargets.bulkUpsert).toHaveBeenCalledWith([
      { domain: 'new.com', priority: 2, radarRank: 1200 },
    ]);
    expect(crawlTargets.bulkUpdateRadarRank).toHaveBeenCalledWith([
      { domain: 'existing.com', radarRank: 1800 },
    ]);
    expect(radarSnapshots.bulkUpsert).toHaveBeenCalledTimes(1);
    expect(queue.enqueueBulk).toHaveBeenCalledTimes(1);

    const enqueuedPayloads = queue.enqueueBulk.mock.calls[0][0];
    expect(enqueuedPayloads.length).toBe(1);
    expect(enqueuedPayloads[0].domain).toBe('new.com');
  });
});
