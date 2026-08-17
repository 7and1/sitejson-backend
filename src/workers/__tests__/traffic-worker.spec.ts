import { describe, expect, it, vi } from 'vitest';

const { fetchWithRetry } = vi.hoisted(() => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock('../../providers/http.js', () => ({
  fetchWithRetry,
}));

import { TrafficWorker } from '../traffic-worker.js';

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('TrafficWorker', () => {
  it('applies no-data cooldown and increments error count', async () => {
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
    const sites = {
      getByDomain: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    };
    const crawlTargets = {
      getByDomain: vi.fn().mockResolvedValue({ errorCount: 2 }),
      update: vi.fn(),
      getTopByRadarRank: vi.fn().mockResolvedValue([]),
    };
    const jobs = {
      markRunning: vi.fn(),
      markFailed: vi.fn(),
    };
    const orchestrator = {
      analyze: vi.fn().mockResolvedValue({
        domain: 'example.com',
        updatedAt: new Date().toISOString(),
        providerHealth: [{
          provider: 'traffic.provider',
          ok: false,
          errorCode: 'TRAFFIC_NO_DATA',
        }],
        _meta: {
          debug: {
            fallback_path: {
              traffic: 'similarweb_api',
            },
          },
        },
      }),
    };

    const worker = new TrafficWorker(
      queue as any,
      sites as any,
      crawlTargets as any,
      jobs as any,
      orchestrator as any,
      noopLogger as any,
      5,
      24 * 30,
      24,
      24 * 30,
    );

    await worker.process({
      jobId: 'job-1',
      domain: 'example.com',
      traceId: 'trc-1',
      phase: 'traffic',
      purpose: 'traffic-refresh',
    });

    expect(orchestrator.analyze).toHaveBeenCalledTimes(1);
    expect(crawlTargets.update).toHaveBeenCalledTimes(1);

    const updatePatch = crawlTargets.update.mock.calls[0][1];
    expect(updatePatch.errorCount).toBe(3);
    expect(typeof updatePatch.nextTrafficAt).toBe('string');
    expect(noopLogger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'traffic_completed',
      traffic_source: 'similarweb_api',
    }));
  });

  it('skips processing when target is still in cooldown', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
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
    const sites = {
      getByDomain: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    };
    const crawlTargets = {
      getByDomain: vi.fn().mockResolvedValue({ errorCount: 1, nextTrafficAt: future }),
      update: vi.fn(),
      getTopByRadarRank: vi.fn().mockResolvedValue([]),
    };
    const jobs = {
      markRunning: vi.fn(),
      markFailed: vi.fn(),
    };
    const orchestrator = {
      analyze: vi.fn(),
    };

    const worker = new TrafficWorker(
      queue as any,
      sites as any,
      crawlTargets as any,
      jobs as any,
      orchestrator as any,
      noopLogger as any,
      5,
      24 * 30,
      24,
      24 * 30,
    );

    await worker.process({
      jobId: 'job-2',
      domain: 'cooldown.com',
      traceId: 'trc-2',
      phase: 'traffic',
      purpose: 'traffic-refresh',
    });

    expect(orchestrator.analyze).not.toHaveBeenCalled();
    expect(crawlTargets.update).not.toHaveBeenCalled();
  });

  it('applies stop-loss when traffic provider result is missing', async () => {
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
    const sites = {
      getByDomain: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    };
    const crawlTargets = {
      getByDomain: vi.fn().mockResolvedValue({ errorCount: 1 }),
      update: vi.fn(),
      getTopByRadarRank: vi.fn().mockResolvedValue([]),
    };
    const jobs = {
      markRunning: vi.fn(),
      markFailed: vi.fn(),
    };
    const orchestrator = {
      analyze: vi.fn().mockResolvedValue({
        domain: 'missing-provider.com',
        updatedAt: new Date().toISOString(),
        providerHealth: [],
      }),
    };

    const worker = new TrafficWorker(
      queue as any,
      sites as any,
      crawlTargets as any,
      jobs as any,
      orchestrator as any,
      noopLogger as any,
      5,
      24 * 30,
      24,
      24 * 30,
    );

    await worker.process({
      jobId: 'job-3',
      domain: 'missing-provider.com',
      traceId: 'trc-3',
      phase: 'traffic',
      purpose: 'traffic-refresh',
    });

    const updatePatch = crawlTargets.update.mock.calls[0][1];
    expect(updatePatch.errorCount).toBe(2);
    expect(typeof updatePatch.nextTrafficAt).toBe('string');
  });

  it('scopes monthly seed to due top-100k Radar domains with stable job ids', async () => {
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
    const sites = {
      getByDomain: vi.fn(),
      upsert: vi.fn(),
    };
    const crawlTargets = {
      getByDomain: vi.fn(),
      update: vi.fn(),
      getTopByRadarRank: vi.fn().mockResolvedValue([
        { domain: 'a.com', radarRank: 10 },
        { domain: 'b.com', radarRank: 100_000 },
      ]),
    };
    const jobs = {
      markRunning: vi.fn(),
      markFailed: vi.fn(),
    };
    const orchestrator = {
      analyze: vi.fn(),
    };

    const worker = new TrafficWorker(
      queue as any,
      sites as any,
      crawlTargets as any,
      jobs as any,
      orchestrator as any,
      noopLogger as any,
      2,
      24 * 30,
      24 * 7,
      24 * 30,
      800,
      30,
      true,
    );

    await worker.process({
      jobId: 'traffic-monthly-seed',
      domain: '',
      traceId: 'trc-seed',
      phase: 'traffic',
      purpose: 'traffic-monthly-seed',
    });

    expect(crawlTargets.getTopByRadarRank).toHaveBeenCalledWith(100_000, {
      dueOnly: true,
      maxRadarRank: 100_000,
    });
    expect(queue.enqueueBulk).toHaveBeenCalledTimes(1);
    const payloads = queue.enqueueBulk.mock.calls[0][0];
    expect(payloads.map((payload: { jobId: string }) => payload.jobId)).toEqual([
      'traffic-monthly-a.com',
      'traffic-monthly-b.com',
    ]);
    expect(payloads[0]).toMatchObject({ domain: 'a.com', delayMs: 0 });
    expect(payloads[1]).toMatchObject({ domain: 'b.com', delayMs: 86_400_000 });
  });

  it('skips monthly seed when Redis memory is above the hard stop ratio', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const queue = {
      enqueue: vi.fn(),
      enqueueBulk: vi.fn(),
      addRepeatable: vi.fn(),
      consume: vi.fn(),
      getCounts: vi.fn(),
      getAllCounts: vi.fn(),
      getRedisMemorySnapshot: vi.fn().mockResolvedValue({
        usedBytes: 900,
        maxBytes: 1000,
        ratio: 0.9,
      }),
      retryFailed: vi.fn(),
      healthCheck: vi.fn(),
    };
    const sites = {
      getByDomain: vi.fn(),
      upsert: vi.fn(),
    };
    const crawlTargets = {
      getByDomain: vi.fn(),
      update: vi.fn(),
      getTopByRadarRank: vi.fn(),
    };
    const jobs = {
      markRunning: vi.fn(),
      markFailed: vi.fn(),
    };
    const orchestrator = {
      analyze: vi.fn(),
    };
    const worker = new TrafficWorker(
      queue as any,
      sites as any,
      crawlTargets as any,
      jobs as any,
      orchestrator as any,
      logger as any,
      2,
      24 * 30,
      24 * 7,
      24 * 30,
      800,
      30,
      true,
    );

    await worker.process({
      jobId: 'traffic-monthly-seed',
      domain: '',
      traceId: 'trc-seed-memory',
      phase: 'traffic',
      purpose: 'traffic-monthly-seed',
    });

    expect(crawlTargets.getTopByRadarRank).not.toHaveBeenCalled();
    expect(queue.enqueueBulk).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'monthly_seed_skipped_redis_memory',
      redis_memory_ratio: 0.9,
      hard_stop_ratio: 0.85,
    }));
  });

  it('ignores a legacy monthly repeatable when monthly seeding is disabled', async () => {
    const queue = {
      enqueueBulk: vi.fn(),
    };
    const crawlTargets = {
      getTopByRadarRank: vi.fn(),
    };
    const worker = new TrafficWorker(
      queue as any,
      {} as any,
      crawlTargets as any,
      {} as any,
      {} as any,
      noopLogger as any,
      30,
      24 * 30,
      24 * 7,
      24 * 30,
      10,
      30,
      false,
    );

    await worker.process({
      jobId: 'legacy-monthly-repeatable',
      domain: '',
      traceId: 'trc-monthly-disabled',
      phase: 'traffic',
      purpose: 'traffic-monthly-seed',
    });

    expect(crawlTargets.getTopByRadarRank).not.toHaveBeenCalled();
    expect(queue.enqueueBulk).not.toHaveBeenCalled();
  });

  it('seeds SimilarWeb in Radar-rank order and caps one request at 50 domains', async () => {
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
    const sites = {
      getByDomain: vi.fn(),
      upsert: vi.fn(),
    };
    const ranked = Array.from({ length: 50 }, (_, index) => ({
      domain: `rank-${String(index + 1).padStart(2, '0')}.example`,
      radarRank: index + 1,
    }));
    const crawlTargets = {
      getByDomain: vi.fn(),
      update: vi.fn(),
      getSimilarwebCollectSeedDomains: vi.fn().mockResolvedValue(ranked),
    };
    const jobs = {
      markRunning: vi.fn(),
      markFailed: vi.fn(),
    };
    const orchestrator = {
      analyze: vi.fn(),
    };
    fetchWithRetry.mockResolvedValueOnce({ status: 202 });

    const worker = new TrafficWorker(
      queue as any,
      sites as any,
      crawlTargets as any,
      jobs as any,
      orchestrator as any,
      noopLogger as any,
      30,
      24 * 30,
      24 * 7,
      24 * 30,
      10,
      30,
      false,
      {
        enabled: true,
        baseUrl: 'http://sitejson-similarweb-api:3000/',
        apiKey: 'internal-test-key',
        batchSize: 80,
        maxSnapshotAgeDays: 30,
        timeoutMs: 12000,
      },
    );

    await worker.process({
      jobId: 'traffic-similarweb-collect-seed',
      domain: '',
      traceId: 'trc-sw-seed',
      phase: 'traffic',
      purpose: 'traffic-similarweb-collect-seed',
    });

    expect(crawlTargets.getSimilarwebCollectSeedDomains).toHaveBeenCalledWith(50, {
      maxSnapshotAgeDays: 30,
    });
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    const [url, options] = fetchWithRetry.mock.calls[0];
    expect(url).toBe('http://sitejson-similarweb-api:3000/api/v1/collect');
    expect(options.requestInit.headers['x-api-key']).toBe('internal-test-key');
    const body = JSON.parse(options.requestInit.body as string);
    expect(body.priority).toBe('low');
    expect(body.domains).toHaveLength(50);
    expect(body.domains[0]).toBe('rank-01.example');
    expect(body.domains[49]).toBe('rank-50.example');
    expect(queue.enqueueBulk).toHaveBeenCalledTimes(1);
    const [followups, queueName] = queue.enqueueBulk.mock.calls[0];
    expect(queueName).toBe('traffic');
    expect(followups).toHaveLength(50);
    expect(followups[0]).toMatchObject({
      jobId: 'traffic-similarweb-followup-rank-01.example',
      domain: 'rank-01.example',
      purpose: 'traffic-refresh',
      delayMs: 15 * 60 * 1000,
    });
  });
});
