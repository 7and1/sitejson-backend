import { describe, expect, it, vi } from 'vitest';
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
});
