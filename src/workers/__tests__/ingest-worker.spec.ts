import { describe, expect, it, vi } from 'vitest';
import { IngestWorker } from '../ingest-worker.js';

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('IngestWorker scheduled feeds', () => {
  it('enqueues high-rank first-run domains via ingest auto-feed', async () => {
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

    const crawlTargets = {
      evaluateDue: vi.fn(),
      getHighRankFirstRunDomains: vi.fn(),
      claimHighRankFirstRunDomains: vi.fn().mockResolvedValue([
        { domain: 'a.com', radarRank: 11, isHighValue: true },
        { domain: 'b.com', radarRank: 20, isHighValue: true },
      ]),
      releaseClaimedFirstRunDomains: vi.fn(),
      getBrowserSuccessTaxonomyMissingDomains: vi.fn(),
      update: vi.fn(),
    };

    const jobs = {
      markRunning: vi.fn(),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    };

    const worker = new IngestWorker(
      queue as any,
      crawlTargets as any,
      jobs as any,
      noopLogger as any,
      100,
      100_000,
      100,
      300_000,
    );

    await worker.process({
      jobId: 'repeat-ingest',
      domain: '',
      traceId: '',
      phase: 'ingest',
      purpose: 'ingest-auto-feed',
    });

    expect(crawlTargets.claimHighRankFirstRunDomains).toHaveBeenCalledWith(100, {
      maxRadarRank: 100_000,
    });
    expect(queue.enqueueBulk).toHaveBeenCalledTimes(1);
    expect(queue.enqueueBulk.mock.calls[0][1]).toBe('ingest');

    const payloads = queue.enqueueBulk.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({
      domain: 'a.com',
      source: 'system',
      phase: 'ingest',
      purpose: 'analysis',
      priority: 'high',
      isHighValue: true,
    });

    expect(crawlTargets.releaseClaimedFirstRunDomains).not.toHaveBeenCalled();
  });

  it('enqueues ai-only browser reclassify jobs via ai-retry-feed', async () => {
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

    const crawlTargets = {
      evaluateDue: vi.fn(),
      getHighRankFirstRunDomains: vi.fn(),
      claimHighRankFirstRunDomains: vi.fn(),
      releaseClaimedFirstRunDomains: vi.fn(),
      getBrowserSuccessTaxonomyMissingDomains: vi.fn().mockResolvedValue([
        { domain: 'taxonomy-missing.com', radarRank: 77, isHighValue: true },
      ]),
      update: vi.fn(),
    };

    const jobs = {
      markRunning: vi.fn(),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    };

    const worker = new IngestWorker(
      queue as any,
      crawlTargets as any,
      jobs as any,
      noopLogger as any,
      100,
      100_000,
      50,
      200_000,
    );

    await worker.process({
      jobId: 'repeat-ai-retry',
      domain: '',
      traceId: 'trc_seed',
      phase: 'ingest',
      purpose: 'ai-retry-feed',
    });

    expect(crawlTargets.getBrowserSuccessTaxonomyMissingDomains).toHaveBeenCalledWith(50, expect.objectContaining({
      maxRadarRank: 200_000,
    }));
    expect(queue.enqueueBulk).toHaveBeenCalledTimes(1);
    expect(queue.enqueueBulk.mock.calls[0][1]).toBe('browser');

    const payload = queue.enqueueBulk.mock.calls[0][0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      domain: 'taxonomy-missing.com',
      source: 'system',
      dispatchLane: 'background',
      phase: 'browser',
      purpose: 'ai-reclassify',
      forceAi: true,
      skipAi: false,
      aiReclassify: true,
      priority: 'high',
      isHighValue: true,
    });

    expect(crawlTargets.update).not.toHaveBeenCalled();
  });

  it('routes realtime analysis jobs to browser_realtime', async () => {
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

    const crawlTargets = {
      evaluateDue: vi.fn().mockResolvedValue({
        needsBrowser: true,
        needsRadar: false,
        needsAsync: false,
        radarRank: 500,
        isHighValue: true,
      }),
      update: vi.fn(),
      getHighRankFirstRunDomains: vi.fn(),
      claimHighRankFirstRunDomains: vi.fn(),
      releaseClaimedFirstRunDomains: vi.fn(),
      getBrowserSuccessTaxonomyMissingDomains: vi.fn(),
    };

    const jobs = {
      markRunning: vi.fn(),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    };

    const worker = new IngestWorker(
      queue as any,
      crawlTargets as any,
      jobs as any,
      noopLogger as any,
      100,
      100_000,
      50,
      200_000,
    );

    await worker.process({
      jobId: 'job-live',
      crawlJobId: 'job-live',
      domain: 'example.com',
      traceId: 'trc-live',
      dispatchLane: 'realtime',
      phase: 'ingest',
      purpose: 'analysis',
      source: 'api',
    });

    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'example.com',
        phase: 'browser_realtime',
        purpose: 'browser',
        priority: 'high',
      }),
      'browser_realtime',
    );
  });

  it('releases claimed domains when ingest auto-feed enqueue fails', async () => {
    const queue = {
      enqueue: vi.fn(),
      enqueueBulk: vi.fn().mockRejectedValue(new Error('redis down')),
      addRepeatable: vi.fn(),
      consume: vi.fn(),
      getCounts: vi.fn(),
      getAllCounts: vi.fn(),
      retryFailed: vi.fn(),
      healthCheck: vi.fn(),
    };

    const crawlTargets = {
      evaluateDue: vi.fn(),
      getHighRankFirstRunDomains: vi.fn(),
      claimHighRankFirstRunDomains: vi.fn().mockResolvedValue([
        { domain: 'stuck.com', radarRank: 9, isHighValue: true },
      ]),
      releaseClaimedFirstRunDomains: vi.fn().mockResolvedValue(undefined),
      getBrowserSuccessTaxonomyMissingDomains: vi.fn(),
      update: vi.fn(),
    };

    const jobs = {
      markRunning: vi.fn(),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    };

    const worker = new IngestWorker(
      queue as any,
      crawlTargets as any,
      jobs as any,
      noopLogger as any,
      100,
      100_000,
      50,
      200_000,
    );

    await expect(worker.process({
      jobId: 'repeat-ingest',
      domain: '',
      traceId: 'trc_fail',
      phase: 'ingest',
      purpose: 'ingest-auto-feed',
    })).rejects.toThrowError('redis down');

    expect(crawlTargets.releaseClaimedFirstRunDomains).toHaveBeenCalledWith(['stuck.com']);
  });
});
