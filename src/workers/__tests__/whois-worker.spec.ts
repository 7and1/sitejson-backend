import { describe, expect, it, vi } from 'vitest';
import { WhoisWorker } from '../whois-worker.js';

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('WhoisWorker', () => {
  it('processes whois phase and merges report', async () => {
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
      getByDomain: vi.fn().mockResolvedValue({
        domain: 'example.com',
        updatedAt: '2026-02-01T00:00:00.000Z',
        trafficData: {
          monthlyVisits: 123,
        },
      }),
      upsert: vi.fn(),
    };
    const crawlTargets = {
      getByDomain: vi.fn().mockResolvedValue({ whoisErrorCount: 0 }),
      update: vi.fn(),
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
          provider: 'whois.provider',
          ok: true,
        }],
        trafficData: {
          whois: {
            registrar: 'Example Registrar',
            createdAt: '2020-01-01T00:00:00Z',
            expiresAt: null,
            updatedAt: null,
            nameservers: [],
            status: [],
          },
          domainAgeYears: 6.1,
        },
      }),
    };

    const worker = new WhoisWorker(
      queue as any,
      sites as any,
      crawlTargets as any,
      jobs as any,
      orchestrator as any,
      noopLogger as any,
    );

    await worker.process({
      jobId: 'job-1',
      domain: 'example.com',
      traceId: 'trc-1',
      phase: 'whois',
      purpose: 'whois-refresh',
    });

    expect(orchestrator.analyze).toHaveBeenCalledWith(
      'example.com',
      'trc-1',
      expect.objectContaining({
        phase: 'whois',
        forceRefresh: true,
        skipAi: true,
      }),
    );
    expect(sites.upsert).toHaveBeenCalledTimes(1);
    expect(crawlTargets.update).toHaveBeenCalledTimes(1);
    const updatePatch = crawlTargets.update.mock.calls[0][1];
    expect(updatePatch.whoisErrorCount).toBe(0);
    expect(typeof updatePatch.nextWhoisAt).toBe('string');
  });

  it('applies no-data cooldown and increments whois error count', async () => {
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
      getByDomain: vi.fn().mockResolvedValue({ whoisErrorCount: 2 }),
      update: vi.fn(),
    };
    const jobs = {
      markRunning: vi.fn(),
      markFailed: vi.fn(),
    };
    const orchestrator = {
      analyze: vi.fn().mockResolvedValue({
        domain: 'nodata.com',
        updatedAt: new Date().toISOString(),
        providerHealth: [{
          provider: 'whois.provider',
          ok: true,
        }],
        trafficData: {
          whois: undefined,
          domainAgeYears: null,
        },
      }),
    };

    const worker = new WhoisWorker(
      queue as any,
      sites as any,
      crawlTargets as any,
      jobs as any,
      orchestrator as any,
      noopLogger as any,
      24 * 30,
      24,
      24 * 30,
    );

    await worker.process({
      jobId: 'job-nodata',
      domain: 'nodata.com',
      traceId: 'trc-nodata',
      phase: 'whois',
      purpose: 'whois-refresh',
    });

    const updatePatch = crawlTargets.update.mock.calls[0][1];
    expect(updatePatch.whoisErrorCount).toBe(3);
    expect(typeof updatePatch.nextWhoisAt).toBe('string');
  });

  it('skips processing when whois target is still in cooldown', async () => {
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
      getByDomain: vi.fn().mockResolvedValue({ whoisErrorCount: 1, nextWhoisAt: future }),
      update: vi.fn(),
    };
    const jobs = {
      markRunning: vi.fn(),
      markFailed: vi.fn(),
    };
    const orchestrator = {
      analyze: vi.fn(),
    };

    const worker = new WhoisWorker(
      queue as any,
      sites as any,
      crawlTargets as any,
      jobs as any,
      orchestrator as any,
      noopLogger as any,
    );

    await worker.process({
      jobId: 'job-cooldown',
      domain: 'cooldown.com',
      traceId: 'trc-cooldown',
      phase: 'whois',
      purpose: 'whois-refresh',
    });

    expect(orchestrator.analyze).not.toHaveBeenCalled();
    expect(crawlTargets.update).not.toHaveBeenCalled();
  });
});
