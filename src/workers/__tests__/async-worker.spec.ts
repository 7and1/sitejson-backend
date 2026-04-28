import { describe, expect, it, vi } from 'vitest';
import { AsyncWorker } from '../async-worker.js';

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('AsyncWorker', () => {
  it('passes skipAi through to orchestrator analyze', async () => {
    const queue = {
      consume: vi.fn(),
    };

    const sites = {
      getByDomain: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    };

    const crawlTargets = {
      markLayerResult: vi.fn(),
      update: vi.fn(),
    };

    const jobs = {
      markRunning: vi.fn(),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    };

    const orchestrator = {
      analyze: vi.fn().mockResolvedValue({
        domain: 'example.com',
        updatedAt: new Date().toISOString(),
        dns: { provider: 'Other', mxRecords: [], nsRecords: [], txtRecords: [] },
      }),
    };

    const worker = new AsyncWorker(
      queue as any,
      sites as any,
      crawlTargets as any,
      jobs as any,
      orchestrator as any,
      noopLogger as any,
      2,
    );

    await worker.process({
      jobId: 'job-async',
      crawlJobId: 'crawl-1',
      domain: 'example.com',
      traceId: 'trc-async',
      phase: 'async',
      purpose: 'async-fill',
      skipAi: true,
    });

    expect(orchestrator.analyze).toHaveBeenCalledWith(
      'example.com',
      'trc-async',
      expect.objectContaining({
        phase: 'async',
        skipAi: true,
      }),
    );
  });
});
