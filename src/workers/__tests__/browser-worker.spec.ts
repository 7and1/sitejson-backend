import { describe, expect, it, vi } from 'vitest';
import { BrowserWorker } from '../browser-worker.js';
import { computeContentHash } from '../../services/content-hash.js';

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

describe('BrowserWorker aiReclassify mode', () => {
  it('runs ai-only reclassify without re-marking browser success', async () => {
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
        meta: {
          title: 'Example',
          description: 'Example description',
          techStackDetected: ['React'],
        },
        seo: {
          h1Count: 1,
          h2Count: 2,
          internalLinks: 10,
          externalLinks: 1,
          imagesCount: 3,
        },
        _meta: {
          html: {
            primary_h1: 'Example heading',
            length: 1200,
          },
        },
      }),
      upsert: vi.fn(),
    };

    const crawlTargets = {
      getByDomain: vi.fn().mockResolvedValue({
        isHighValue: true,
        radarRank: 100,
        taxonomyData: undefined,
        taxonomyPromptVersion: 1,
        lastContentHash: 'hash-1',
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
        taxonomy: {
          iabCategory: 'Technology & Computing',
          iabSubCategory: 'Software',
          confidence: 0.92,
          tags: ['saas'],
        },
      }),
    };

    const worker = new BrowserWorker(
      queue as any,
      sites as any,
      crawlTargets as any,
      jobs as any,
      orchestrator as any,
      noopLogger as any,
      2,
    );

    await worker.process({
      jobId: 'job-ai-reclassify',
      domain: 'example.com',
      traceId: 'trc-ai-reclassify',
      phase: 'browser',
      purpose: 'ai-reclassify',
      aiReclassify: true,
      forceAi: false,
      skipAi: true,
    });

    expect(orchestrator.analyze).toHaveBeenCalledWith(
      'example.com',
      'trc-ai-reclassify',
      expect.objectContaining({
        phase: 'browser',
        aiReclassify: true,
        forceAi: true,
        skipAi: false,
        aiSeedSignals: expect.objectContaining({
          title: 'Example',
          h1Count: 1,
          contentLength: 1200,
        }),
      }),
    );

    expect(crawlTargets.markLayerResult).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(crawlTargets.update).toHaveBeenCalledWith(
      'example.com',
      expect.objectContaining({
        taxonomyPromptVersion: 2,
        taxonomyLastTriggerReason: 'force_ai',
        lastContentHash: 'hash-1',
      }),
    );
  });

  it('does not mark browser failed when ai reclassify throws', async () => {
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
      getByDomain: vi.fn().mockResolvedValue({
        isHighValue: true,
        radarRank: 10,
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
      analyze: vi.fn().mockRejectedValue(new Error('AI provider failed')),
    };

    const worker = new BrowserWorker(
      queue as any,
      sites as any,
      crawlTargets as any,
      jobs as any,
      orchestrator as any,
      noopLogger as any,
      2,
    );

    await expect(worker.process({
      jobId: 'job-ai-reclassify-fail',
      crawlJobId: 'crawl-1',
      domain: 'example.com',
      traceId: 'trc-ai-reclassify-fail',
      phase: 'browser',
      purpose: 'ai-reclassify',
      aiReclassify: true,
    })).rejects.toThrow('AI provider failed');

    expect(crawlTargets.markLayerResult).not.toHaveBeenCalled();
    expect(jobs.markFailed).toHaveBeenCalledWith(
      'crawl-1',
      'AI provider failed',
      'ai_reclassify_failed',
    );
  });
});

describe('BrowserWorker async-fill enqueue', () => {
  it('propagates skipAi and forceRefresh to async job payload', async () => {
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
      getByDomain: vi.fn().mockResolvedValue({
        isHighValue: false,
        radarRank: 50000,
        taxonomyData: undefined,
        taxonomyPromptVersion: 1,
        lastContentHash: undefined,
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
        visual: { screenshotUrl: 'https://cdn.example.com/s.webp', storage: 'r2' },
        meta: { title: 'Example', description: 'Example', techStackDetected: [] },
        seo: { h1Count: 1, h2Count: 0, internalLinks: 1, externalLinks: 0, imagesCount: 0 },
        _meta: { html: { primary_h1: 'Example', length: 123 } },
      }),
    };

    const worker = new BrowserWorker(
      queue as any,
      sites as any,
      crawlTargets as any,
      jobs as any,
      orchestrator as any,
      noopLogger as any,
      2,
    );

    await worker.process({
      jobId: 'job-browser',
      crawlJobId: 'crawl-1',
      domain: 'example.com',
      traceId: 'trc-browser',
      phase: 'browser',
      purpose: 'browser',
      forceRefresh: true,
      skipAi: true,
    });

    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'async',
        purpose: 'async-fill',
        parentJobId: 'job-browser',
        domain: 'example.com',
        traceId: 'trc-browser',
        forceRefresh: true,
        skipAi: true,
      }),
      'async',
    );
    expect(queue.enqueue.mock.calls[0][0]).not.toHaveProperty('crawlJobId');
    expect(jobs.markCompleted).toHaveBeenCalledWith('crawl-1', 'browser_completed', 100);
  });

  it('skips async AI when content hash is unchanged and taxonomy is current', async () => {
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

    const report = {
      domain: 'example.com',
      updatedAt: new Date().toISOString(),
      visual: { screenshotUrl: 'https://cdn.example.com/s.webp', storage: 'r2' as const },
      meta: { title: 'Example', description: 'Example', techStackDetected: [] },
      seo: { h1Count: 1, h2Count: 0, internalLinks: 1, externalLinks: 0, imagesCount: 0 },
      _meta: { html: { primary_h1: 'Example', length: 123 } },
    };
    const contentHash = computeContentHash({
      title: report.meta.title,
      description: report.meta.description,
      primaryH1: report._meta.html.primary_h1,
      contentLength: report._meta.html.length,
    });

    const sites = {
      getByDomain: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    };

    const crawlTargets = {
      getByDomain: vi.fn().mockResolvedValue({
        isHighValue: false,
        radarRank: 50_000,
        taxonomyData: {
          iabCategory: 'Technology & Computing',
          iabSubCategory: 'Software',
          confidence: 0.92,
          tags: ['saas'],
        },
        taxonomyPromptVersion: 2,
        lastContentHash: contentHash,
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
      analyze: vi.fn().mockResolvedValue(report),
    };

    const worker = new BrowserWorker(
      queue as any,
      sites as any,
      crawlTargets as any,
      jobs as any,
      orchestrator as any,
      noopLogger as any,
      2,
    );

    await worker.process({
      jobId: 'job-browser',
      domain: 'example.com',
      traceId: 'trc-browser',
      phase: 'browser',
      purpose: 'browser',
    });

    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'async',
        skipAi: true,
        contentHash,
      }),
      'async',
    );
  });

  it('clears the previous content hash when the browser crawl is blocked', async () => {
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
      getByDomain: vi.fn().mockResolvedValue({
        isHighValue: false,
        radarRank: 50_000,
        taxonomyData: {
          iabCategory: 'Technology & Computing',
          iabSubCategory: 'Software',
          confidence: 0.92,
          tags: ['saas'],
        },
        taxonomyPromptVersion: 2,
        lastContentHash: 'poisoned-hash',
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
        domain: 'blocked.example',
        updatedAt: new Date().toISOString(),
        visual: { screenshotUrl: 'https://cdn.example.com/s.webp', storage: 'r2' },
        providerHealth: [
          { provider: 'meta.provider', ok: false, errorCode: 'BOT_CHALLENGE_BLOCKED' },
        ],
        _meta: {
          html: {
            blocked: true,
            source: 'browser',
            length: 0,
          },
        },
      }),
    };

    const worker = new BrowserWorker(
      queue as any,
      sites as any,
      crawlTargets as any,
      jobs as any,
      orchestrator as any,
      noopLogger as any,
      2,
    );

    await worker.process({
      jobId: 'job-browser-blocked',
      domain: 'blocked.example',
      traceId: 'trc-browser-blocked',
      phase: 'browser',
      purpose: 'browser',
    });

    expect(crawlTargets.update).toHaveBeenCalledWith(
      'blocked.example',
      expect.objectContaining({
        lastContentHash: null,
      }),
    );
    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'async',
        contentHash: undefined,
      }),
      'async',
    );
  });

  it('sends a completion webhook when the crawl job finishes', async () => {
    vi.clearAllMocks();
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
      getByDomain: vi.fn().mockResolvedValue({
        isHighValue: false,
        radarRank: 50_000,
        taxonomyData: undefined,
        taxonomyPromptVersion: 1,
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
        meta: { title: 'Example', description: 'Example', techStackDetected: [] },
        seo: { h1Count: 1, h2Count: 0, internalLinks: 1, externalLinks: 0, imagesCount: 0 },
        _meta: { html: { primary_h1: 'Example', length: 123 } },
      }),
    };

    const worker = new BrowserWorker(
      queue as any,
      sites as any,
      crawlTargets as any,
      jobs as any,
      orchestrator as any,
      noopLogger as any,
      2,
    );

    await worker.process({
      jobId: 'job-browser',
      crawlJobId: 'crawl-1',
      domain: 'example.com',
      traceId: 'trc-browser',
      phase: 'browser',
      purpose: 'browser',
      webhookUrl: 'https://hooks.example.com/sitejson',
      priority: 'normal',
    });

    expect(notifyAnalyzeCompleted).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        webhookUrl: 'https://hooks.example.com/sitejson',
        jobId: 'crawl-1',
        domain: 'example.com',
        stage: 'browser_completed',
      }),
    );
  });
});
