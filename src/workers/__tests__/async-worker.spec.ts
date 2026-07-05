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
      getByDomain: vi.fn().mockResolvedValue(null),
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

  it('does not mutate crawl job lifecycle when async-fill has no crawlJobId', async () => {
    const queue = {
      consume: vi.fn(),
    };

    const sites = {
      getByDomain: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    };

    const crawlTargets = {
      getByDomain: vi.fn().mockResolvedValue(null),
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
      parentJobId: 'job-browser',
      domain: 'example.com',
      traceId: 'trc-async',
      phase: 'async',
      purpose: 'async-fill',
      skipAi: true,
    });

    expect(jobs.markRunning).not.toHaveBeenCalled();
    expect(jobs.markCompleted).not.toHaveBeenCalled();
    expect(jobs.markFailed).not.toHaveBeenCalled();
    expect(crawlTargets.markLayerResult).toHaveBeenCalledWith('example.com', 'async', 'success');
  });

  it('skips authority provider when cached Ahrefs DR is still fresh', async () => {
    const queue = {
      consume: vi.fn(),
    };

    const sites = {
      getByDomain: vi.fn().mockResolvedValue({
        domain: 'example.com',
        updatedAt: new Date().toISOString(),
        authority: {
          domainRating: 91,
          source: 'ahrefs',
          licenseUrl: 'https://ahrefs.com/legal/domain-rating-license',
          attribution: 'Domain Rating by Ahrefs',
          fetchedAt: new Date().toISOString(),
        },
      }),
      upsert: vi.fn(),
    };

    const crawlTargets = {
      getByDomain: vi.fn().mockResolvedValue(null),
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
      720,
    );

    await worker.process({
      jobId: 'job-async',
      domain: 'example.com',
      traceId: 'trc-async',
      phase: 'async',
      purpose: 'async-fill',
    });

    expect(orchestrator.analyze).toHaveBeenCalledWith(
      'example.com',
      'trc-async',
      expect.objectContaining({
        phase: 'async',
        skipAuthority: true,
      }),
    );
    expect(sites.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'example.com',
      }),
      expect.objectContaining({
        previousReport: expect.objectContaining({
          authority: expect.objectContaining({
            domainRating: 91,
            fetchedAt: expect.any(String),
          }),
        }),
      }),
    );
  });

  it('refreshes authority provider when forceRefresh is requested', async () => {
    const queue = {
      consume: vi.fn(),
    };

    const sites = {
      getByDomain: vi.fn().mockResolvedValue({
        domain: 'example.com',
        updatedAt: new Date().toISOString(),
        authority: {
          domainRating: 91,
          source: 'ahrefs',
          licenseUrl: 'https://ahrefs.com/legal/domain-rating-license',
          attribution: 'Domain Rating by Ahrefs',
          fetchedAt: new Date().toISOString(),
        },
      }),
      upsert: vi.fn(),
    };

    const crawlTargets = {
      getByDomain: vi.fn().mockResolvedValue(null),
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
        authority: {
          domainRating: 92,
          source: 'ahrefs',
          licenseUrl: 'https://ahrefs.com/legal/domain-rating-license',
          attribution: 'Domain Rating by Ahrefs',
          fetchedAt: new Date().toISOString(),
        },
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
      720,
    );

    await worker.process({
      jobId: 'job-async',
      domain: 'example.com',
      traceId: 'trc-async',
      phase: 'async',
      purpose: 'async-fill',
      forceRefresh: true,
    });

    expect(orchestrator.analyze).toHaveBeenCalledWith(
      'example.com',
      'trc-async',
      expect.objectContaining({
        phase: 'async',
        forceRefresh: true,
        skipAuthority: false,
      }),
    );
    expect(sites.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: expect.objectContaining({
          domainRating: 92,
        }),
      }),
      expect.objectContaining({
        previousReport: expect.objectContaining({
          authority: expect.objectContaining({
            domainRating: 91,
          }),
        }),
      }),
    );
  });

  it('forwards rank context so AI vision gating can make a cost-aware decision', async () => {
    const queue = {
      consume: vi.fn(),
    };

    const sites = {
      getByDomain: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    };

    const crawlTargets = {
      getByDomain: vi.fn().mockResolvedValue({
        isHighValue: false,
        radarRank: 2_500,
      }),
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
      domain: 'example.com',
      traceId: 'trc-async',
      phase: 'async',
      purpose: 'async-fill',
    });

    expect(orchestrator.analyze).toHaveBeenCalledWith(
      'example.com',
      'trc-async',
      expect.objectContaining({
        phase: 'async',
        isHighValue: false,
        radarRank: 2_500,
      }),
    );
  });
});
