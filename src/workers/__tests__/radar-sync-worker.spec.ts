import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../observability/logger.js';
import { RadarSyncWorker } from '../radar-sync-worker.js';

describe('RadarSyncWorker batch processing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses bulk repositories and records first-run candidates without bypassing ingest feed guardrails', async () => {
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
      removeRepeatables: vi.fn(),
      consume: vi.fn(),
      getCounts: vi.fn(),
      getAllCounts: vi.fn(),
      getRedisMemorySnapshot: vi.fn(),
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
      { domain: 'new.com', priority: 2, isHighValue: true, radarRank: 1200 },
      { domain: 'existing.com', priority: 2, isHighValue: true, radarRank: 1800 },
    ]);
    expect(crawlTargets.bulkUpdateRadarRank).not.toHaveBeenCalled();
    expect(radarSnapshots.bulkUpsert).toHaveBeenCalledTimes(1);
    expect(queue.enqueueBulk).not.toHaveBeenCalled();
  });

  it('warns when a bulk dataset is smaller than the configured seed threshold', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const radarSnapshots = {
      getByDomain: vi.fn(),
      upsert: vi.fn(),
      bulkUpsert: vi.fn(),
      healthCheck: vi.fn(),
    };
    const crawlTargets = {
      upsert: vi.fn(),
      getByDomain: vi.fn(),
      getExistingDomains: vi.fn().mockResolvedValue(new Set()),
      bulkUpsert: vi.fn(),
      bulkUpdateRadarRank: vi.fn(),
      markLayerResult: vi.fn(),
      update: vi.fn(),
      evaluateDue: vi.fn(),
      getDueBatch: vi.fn(),
      getTopByRadarRank: vi.fn(),
      healthCheck: vi.fn(),
    };
    const worker = new RadarSyncWorker(
      radarSnapshots as any,
      crawlTargets as any,
      {} as any,
      {} as any,
      logger as any,
      'token',
      'ranking_bucket',
      100,
      0,
      1,
      10_000,
      5,
    ) as any;

    worker.getDatasetDownloadUrl = vi.fn().mockResolvedValue('https://radar.example/top.csv');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('1,one.com\n2,two.com\n', { status: 200 })));

    await worker.process({ jobId: 'radar-bulk', domain: '', traceId: 'trc_scope', purpose: 'radar-bulk-sync' });

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'bulk_csv_scope_below_expectation',
      valid_rows: 2,
      min_valid_rows: 5,
    }));
  });

  it('rethrows single-domain fetch failures after marking the crawl job failed', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const radarSnapshots = {
      getByDomain: vi.fn(),
      upsert: vi.fn(),
      bulkUpsert: vi.fn(),
      healthCheck: vi.fn(),
    };
    const crawlTargets = {
      upsert: vi.fn(),
      getByDomain: vi.fn(),
      getExistingDomains: vi.fn(),
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
      releaseStaleActiveJobs: vi.fn(),
      healthCheck: vi.fn(),
    };
    const worker = new RadarSyncWorker(
      radarSnapshots as any,
      crawlTargets as any,
      jobs as any,
      {} as any,
      logger as any,
      'token',
      'ranking_bucket',
      100,
      0,
    );
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('radar down')));

    await expect(worker.process({
      jobId: 'radar-single',
      crawlJobId: 'crawl-radar',
      domain: 'example.com',
      traceId: 'trc_radar_fail',
      purpose: 'radar-sync',
    })).rejects.toThrow('radar down');

    expect(crawlTargets.markLayerResult).toHaveBeenCalledWith('example.com', 'radar', 'failed');
    expect(jobs.markFailed).toHaveBeenCalledWith('crawl-radar', 'radar down', 'radar_failed');
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'snapshot_update_failed',
      error: 'radar down',
    }));
  });

  it('rethrows bulk CSV download failures so BullMQ attempts can retry', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const worker = new RadarSyncWorker(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      logger as any,
      'token',
      'ranking_bucket',
      100,
      0,
    ) as any;

    worker.getDatasetDownloadUrl = vi.fn().mockResolvedValue('https://radar.example/top.csv');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('temporarily unavailable', { status: 503 })));

    await expect(worker.process({
      jobId: 'radar-bulk',
      domain: '',
      traceId: 'trc_bulk_fail',
      purpose: 'radar-bulk-sync',
    })).rejects.toThrow('RADAR_BULK_CSV_DOWNLOAD_FAILED_503');

    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'bulk_csv_failed',
      error: 'RADAR_BULK_CSV_DOWNLOAD_FAILED_503',
    }));
  });
});
