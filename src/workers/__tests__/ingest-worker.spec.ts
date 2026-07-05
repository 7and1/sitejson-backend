import { describe, expect, it, vi } from 'vitest';
import { IngestWorker } from '../ingest-worker.js';

const { notifyAnalyzeCompleted, notifyAnalyzeFailed } = vi.hoisted(() => ({
  notifyAnalyzeCompleted: vi.fn(),
  notifyAnalyzeFailed: vi.fn(),
}));

vi.mock('../../services/analyze-webhook.js', () => ({
  notifyAnalyzeCompleted,
  notifyAnalyzeFailed,
}));

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
      getCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 }),
      getAllCounts: vi.fn(),
      getRedisMemorySnapshot: vi.fn().mockResolvedValue(null),
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
      releaseStaleBrowserPending: vi.fn().mockResolvedValue(0),
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
    expect(crawlTargets.releaseStaleBrowserPending).toHaveBeenCalledWith({
      staleHours: 24,
      limit: 5000,
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

  it('defaults ingest auto-feed to top-1m first-run coverage', async () => {
    const queue = {
      enqueue: vi.fn(),
      enqueueBulk: vi.fn(),
      addRepeatable: vi.fn(),
      consume: vi.fn(),
      getCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 }),
      getAllCounts: vi.fn(),
      getRedisMemorySnapshot: vi.fn().mockResolvedValue(null),
      retryFailed: vi.fn(),
      healthCheck: vi.fn(),
    };

    const crawlTargets = {
      evaluateDue: vi.fn(),
      getHighRankFirstRunDomains: vi.fn(),
      claimHighRankFirstRunDomains: vi.fn().mockResolvedValue([]),
      releaseClaimedFirstRunDomains: vi.fn(),
      releaseStaleBrowserPending: vi.fn().mockResolvedValue(0),
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
    );

    await worker.process({
      jobId: 'repeat-ingest',
      domain: '',
      traceId: 'trc_default_rank',
      phase: 'ingest',
      purpose: 'ingest-auto-feed',
    });

    expect(crawlTargets.claimHighRankFirstRunDomains).toHaveBeenCalledWith(100, {
      maxRadarRank: 1_000_000,
    });
  });

  it('includes ingest backlog in the background feed queue-depth guard', async () => {
    const queue = {
      enqueue: vi.fn(),
      enqueueBulk: vi.fn(),
      addRepeatable: vi.fn(),
      consume: vi.fn(),
      getCounts: vi.fn().mockImplementation(async (queueName: string) => {
        if (queueName === 'ingest') {
          return { waiting: 4900, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 200 };
        }
        return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 };
      }),
      getAllCounts: vi.fn(),
      getRedisMemorySnapshot: vi.fn().mockResolvedValue(null),
      retryFailed: vi.fn(),
      healthCheck: vi.fn(),
    };

    const crawlTargets = {
      evaluateDue: vi.fn(),
      getHighRankFirstRunDomains: vi.fn(),
      claimHighRankFirstRunDomains: vi.fn(),
      releaseClaimedFirstRunDomains: vi.fn(),
      releaseStaleBrowserPending: vi.fn(),
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
      1_000_000,
      50,
      200_000,
      1,
      { backgroundBrowserMaxQueueDepth: 5000 },
    );

    await worker.process({
      jobId: 'repeat-ingest',
      domain: '',
      traceId: 'trc_ingest_depth',
      phase: 'ingest',
      purpose: 'ingest-auto-feed',
    });

    expect(crawlTargets.claimHighRankFirstRunDomains).not.toHaveBeenCalled();
    expect(queue.enqueueBulk).not.toHaveBeenCalled();
  });

  it('releases stale pending first-run claims before claiming new candidates', async () => {
    const queue = {
      enqueue: vi.fn(),
      enqueueBulk: vi.fn(),
      addRepeatable: vi.fn(),
      consume: vi.fn(),
      getCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 }),
      getAllCounts: vi.fn(),
      getRedisMemorySnapshot: vi.fn().mockResolvedValue(null),
      retryFailed: vi.fn(),
      healthCheck: vi.fn(),
    };

    const crawlTargets = {
      evaluateDue: vi.fn(),
      getHighRankFirstRunDomains: vi.fn(),
      claimHighRankFirstRunDomains: vi.fn().mockResolvedValue([]),
      releaseClaimedFirstRunDomains: vi.fn(),
      releaseStaleBrowserPending: vi.fn().mockResolvedValue(7),
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
      1_000_000,
      50,
      200_000,
      1,
      {
        stalePendingReleaseHours: 12,
        stalePendingReleaseLimit: 2500,
      },
    );

    await worker.process({
      jobId: 'repeat-ingest',
      domain: '',
      traceId: 'trc_release_stale',
      phase: 'ingest',
      purpose: 'ingest-auto-feed',
    });

    expect(crawlTargets.releaseStaleBrowserPending).toHaveBeenCalledWith({
      staleHours: 12,
      limit: 2500,
      maxRadarRank: 1_000_000,
    });
    expect(noopLogger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'ingest_auto_feed_stale_pending_released',
      count: 7,
    }));
  });

  it('enqueues ai-only browser reclassify jobs via ai-retry-feed', async () => {
    const queue = {
      enqueue: vi.fn(),
      enqueueBulk: vi.fn(),
      addRepeatable: vi.fn(),
      consume: vi.fn(),
      getCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 }),
      getAllCounts: vi.fn(),
      getRedisMemorySnapshot: vi.fn().mockResolvedValue(null),
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
      getRedisMemorySnapshot: vi.fn().mockResolvedValue(null),
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
      getCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 }),
      getAllCounts: vi.fn(),
      getRedisMemorySnapshot: vi.fn().mockResolvedValue(null),
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

  it('skips ingest auto-feed payloads when the feed is disabled', async () => {
    const queue = {
      enqueue: vi.fn(),
      enqueueBulk: vi.fn(),
      addRepeatable: vi.fn(),
      consume: vi.fn(),
      getCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 }),
      getAllCounts: vi.fn(),
      getRedisMemorySnapshot: vi.fn().mockResolvedValue(null),
      retryFailed: vi.fn(),
      healthCheck: vi.fn(),
    };

    const crawlTargets = {
      evaluateDue: vi.fn(),
      getHighRankFirstRunDomains: vi.fn(),
      claimHighRankFirstRunDomains: vi.fn(),
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
      50,
      200_000,
      1,
      { ingestAutoFeedEnabled: false },
    );

    await worker.process({
      jobId: 'repeat-ingest',
      domain: '',
      traceId: 'trc_disabled',
      phase: 'ingest',
      purpose: 'ingest-auto-feed',
    });

    expect(crawlTargets.claimHighRankFirstRunDomains).not.toHaveBeenCalled();
    expect(queue.enqueueBulk).not.toHaveBeenCalled();
  });

  it('skips background feed claims when browser queue depth is above the guardrail', async () => {
    const queue = {
      enqueue: vi.fn(),
      enqueueBulk: vi.fn(),
      addRepeatable: vi.fn(),
      consume: vi.fn(),
      getCounts: vi.fn().mockResolvedValue({ waiting: 4900, active: 1, completed: 0, failed: 0, delayed: 50, prioritized: 100 }),
      getAllCounts: vi.fn(),
      getRedisMemorySnapshot: vi.fn().mockResolvedValue(null),
      retryFailed: vi.fn(),
      healthCheck: vi.fn(),
    };

    const crawlTargets = {
      evaluateDue: vi.fn(),
      getHighRankFirstRunDomains: vi.fn(),
      claimHighRankFirstRunDomains: vi.fn(),
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
      50,
      200_000,
      1,
      { backgroundBrowserMaxQueueDepth: 5000 },
    );

    await worker.process({
      jobId: 'repeat-ingest',
      domain: '',
      traceId: 'trc_depth',
      phase: 'ingest',
      purpose: 'ingest-auto-feed',
    });

    expect(crawlTargets.claimHighRankFirstRunDomains).not.toHaveBeenCalled();
    expect(queue.enqueueBulk).not.toHaveBeenCalled();
  });

  it('skips background feed claims when Redis memory is above the hard stop ratio', async () => {
    const queue = {
      enqueue: vi.fn(),
      enqueueBulk: vi.fn(),
      addRepeatable: vi.fn(),
      consume: vi.fn(),
      getCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 }),
      getAllCounts: vi.fn(),
      getRedisMemorySnapshot: vi.fn().mockResolvedValue({
        usedBytes: 900,
        maxBytes: 1000,
        ratio: 0.9,
      }),
      retryFailed: vi.fn(),
      healthCheck: vi.fn(),
    };

    const crawlTargets = {
      evaluateDue: vi.fn(),
      getHighRankFirstRunDomains: vi.fn(),
      claimHighRankFirstRunDomains: vi.fn(),
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
      50,
      200_000,
      1,
      { redisFeedHardStopRatio: 0.85 },
    );

    await worker.process({
      jobId: 'repeat-ingest',
      domain: '',
      traceId: 'trc_redis_ratio',
      phase: 'ingest',
      purpose: 'ingest-auto-feed',
    });

    expect(crawlTargets.claimHighRankFirstRunDomains).not.toHaveBeenCalled();
    expect(queue.enqueueBulk).not.toHaveBeenCalled();
  });

  it('enforces the background browser daily budget before claiming more first-run domains', async () => {
    const queue = {
      enqueue: vi.fn(),
      enqueueBulk: vi.fn(),
      addRepeatable: vi.fn(),
      consume: vi.fn(),
      getCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 }),
      getAllCounts: vi.fn(),
      getRedisMemorySnapshot: vi.fn().mockResolvedValue(null),
      retryFailed: vi.fn(),
      healthCheck: vi.fn(),
    };

    const crawlTargets = {
      evaluateDue: vi.fn(),
      getHighRankFirstRunDomains: vi.fn(),
      claimHighRankFirstRunDomains: vi.fn().mockResolvedValue([
        { domain: 'budgeted.com', radarRank: 9, isHighValue: true },
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
      50,
      200_000,
      1,
      { backgroundBrowserDailyBudget: 1 },
    );

    await worker.process({
      jobId: 'repeat-ingest-1',
      domain: '',
      traceId: 'trc_budget_1',
      phase: 'ingest',
      purpose: 'ingest-auto-feed',
    });
    await worker.process({
      jobId: 'repeat-ingest-2',
      domain: '',
      traceId: 'trc_budget_2',
      phase: 'ingest',
      purpose: 'ingest-auto-feed',
    });

    expect(crawlTargets.claimHighRankFirstRunDomains).toHaveBeenCalledTimes(1);
    expect(crawlTargets.claimHighRankFirstRunDomains).toHaveBeenCalledWith(1, {
      maxRadarRank: 100_000,
    });
  });

  it('does not let the watchdog bypass disabled feed flags', async () => {
    const queue = {
      enqueue: vi.fn(),
      enqueueBulk: vi.fn(),
      addRepeatable: vi.fn(),
      consume: vi.fn(),
      getCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 }),
      getAllCounts: vi.fn(),
      getRedisMemorySnapshot: vi.fn().mockResolvedValue(null),
      retryFailed: vi.fn(),
      healthCheck: vi.fn(),
    };

    const crawlTargets = {
      evaluateDue: vi.fn(),
      getHighRankFirstRunDomains: vi.fn(),
      claimHighRankFirstRunDomains: vi.fn(),
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
      50,
      200_000,
      1,
      {
        ingestAutoFeedEnabled: false,
        aiRetryFeedEnabled: false,
      },
    ) as any;

    worker.lastAutoFeedAtMs = 0;
    worker.lastAiRetryAtMs = 0;

    await worker.runWatchdogTick();

    expect(crawlTargets.claimHighRankFirstRunDomains).not.toHaveBeenCalled();
    expect(crawlTargets.getBrowserSuccessTaxonomyMissingDomains).not.toHaveBeenCalled();
  });

  it('sends a completion webhook when ingest resolves to background_queued', async () => {
    vi.clearAllMocks();
    const queue = {
      enqueue: vi.fn(),
      enqueueBulk: vi.fn(),
      addRepeatable: vi.fn(),
      consume: vi.fn(),
      getCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 }),
      getAllCounts: vi.fn(),
      getRedisMemorySnapshot: vi.fn().mockResolvedValue(null),
      retryFailed: vi.fn(),
      healthCheck: vi.fn(),
    };

    const crawlTargets = {
      evaluateDue: vi.fn().mockResolvedValue({
        domain: 'example.com',
        isHighValue: false,
        radarRank: 200_000,
        needsBrowser: false,
        needsRadar: false,
        needsAsync: true,
      }),
      update: vi.fn(),
    };

    const jobs = {
      markRunning: vi.fn(),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    };

    const sites = {
      getByDomain: vi.fn().mockResolvedValue({
        domain: 'example.com',
        updatedAt: new Date().toISOString(),
      }),
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
      1,
      {},
      sites as any,
    );

    await worker.process({
      jobId: 'job-background',
      crawlJobId: 'job-background',
      domain: 'example.com',
      traceId: 'trc-background',
      dispatchLane: 'realtime',
      phase: 'ingest',
      purpose: 'analysis',
      source: 'api',
      webhookUrl: 'https://hooks.example.com/sitejson',
      priority: 'normal',
    });

    expect(jobs.markCompleted).toHaveBeenCalledWith('job-background', 'background_queued', 100);
    expect(notifyAnalyzeCompleted).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        webhookUrl: 'https://hooks.example.com/sitejson',
        jobId: 'job-background',
        domain: 'example.com',
        stage: 'background_queued',
      }),
    );
  });
});
