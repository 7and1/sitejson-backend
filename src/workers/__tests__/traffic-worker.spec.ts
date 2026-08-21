import { afterEach, describe, expect, it, vi } from 'vitest';

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

const similarwebResponse = (data: unknown, status = 200) => ({
  status,
  json: vi.fn().mockResolvedValue(data),
});

const makeSimilarwebWorker = (options?: {
  domains?: string[];
  initialDelayMs?: number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}) => {
  const domains = options?.domains ?? ['example.com'];
  const queue = {
    enqueue: vi.fn(),
    enqueueBulk: vi.fn(),
  };
  const crawlTargets = {
    getByDomain: vi.fn().mockResolvedValue(null),
    update: vi.fn(),
    getSimilarwebCollectSeedDomains: vi.fn().mockResolvedValue(
      domains.map((domain, index) => ({ domain, radarRank: index + 1 })),
    ),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const worker = new TrafficWorker(
    queue as any,
    { getByDomain: vi.fn(), upsert: vi.fn() } as any,
    crawlTargets as any,
    { markRunning: vi.fn(), markFailed: vi.fn() } as any,
    { analyze: vi.fn() } as any,
    logger as any,
    30,
    24 * 30,
    24 * 7,
    24 * 30,
    10,
    30,
    false,
    {
      enabled: true,
      baseUrl: 'http://sitejson-similarweb-api:3000',
      apiKey: 'internal-test-key',
      batchSize: 10,
      maxSnapshotAgeDays: 30,
      timeoutMs: 12000,
      followupInitialDelayMs: options?.initialDelayMs ?? 15 * 60 * 1000,
      followupPollIntervalMs: options?.pollIntervalMs ?? 5 * 60 * 1000,
      followupMaxWaitMs: options?.maxWaitMs ?? 45 * 60 * 1000,
    },
  );

  return { worker, queue, crawlTargets, logger };
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

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

  it('caps the hourly SimilarWeb seed at ten low-priority domains and preserves follow-ups', async () => {
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
    const ranked = Array.from({ length: 10 }, (_, index) => ({
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
    fetchWithRetry.mockResolvedValueOnce(similarwebResponse({
      data: {
        total: 10,
        queued: 10,
        deduped: 0,
        failed: 0,
        results: ranked.map((item, index) => ({
          domain: item.domain,
          queued: true,
          deduped: false,
          job_id: index + 1,
          priority: 'low',
          status: 'pending',
        })),
      },
      meta: { timestamp: '2026-08-17T00:00:00.000Z' },
    }, 202));

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

    expect(crawlTargets.getSimilarwebCollectSeedDomains).toHaveBeenCalledWith(10, {
      maxSnapshotAgeDays: 30,
    });
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    const [url, options] = fetchWithRetry.mock.calls[0];
    expect(url).toBe('http://sitejson-similarweb-api:3000/api/v1/collect');
    expect(options.requestInit.headers['x-api-key']).toBe('internal-test-key');
    const body = JSON.parse(options.requestInit.body as string);
    expect(body.priority).toBe('low');
    expect(body.domains).toHaveLength(10);
    expect(body.domains[0]).toBe('rank-01.example');
    expect(body.domains[9]).toBe('rank-10.example');
    expect(queue.enqueueBulk).toHaveBeenCalledTimes(1);
    const [followups, queueName] = queue.enqueueBulk.mock.calls[0];
    expect(queueName).toBe('traffic');
    expect(followups).toHaveLength(10);
    expect(followups[0]).toMatchObject({
      jobId: 'traffic-similarweb-check-rank-01.example-1-1',
      domain: 'rank-01.example',
      purpose: 'traffic-similarweb-followup-check',
      similarwebJobId: 1,
      followupAttempt: 1,
      delayMs: 15 * 60 * 1000,
    });
  });

  it('falls back only missing or invalid collect rows while preserving valid job checks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T01:00:00.000Z'));
    const { worker, queue } = makeSimilarwebWorker({
      domains: ['good.example', 'missing.example', 'failed.example'],
    });
    fetchWithRetry.mockResolvedValueOnce(similarwebResponse({
      data: {
        total: 3,
        queued: 1,
        deduped: 0,
        failed: 2,
        results: [
          { domain: 'good.example', queued: true, job_id: 41, status: 'pending' },
          { domain: 'failed.example', queued: false, error: 'queue rejected' },
        ],
      },
    }, 202));

    await worker.process({
      jobId: 'seed', domain: '', traceId: 'trc-partial', phase: 'traffic',
      purpose: 'traffic-similarweb-collect-seed',
    });

    const [payloads] = queue.enqueueBulk.mock.calls[0];
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        jobId: 'traffic-similarweb-check-good.example-41-1',
        purpose: 'traffic-similarweb-followup-check',
        similarwebJobId: 41,
        followupDeadlineAt: '2026-08-17T01:45:00.000Z',
      }),
      expect.objectContaining({
        domain: 'missing.example',
        purpose: 'traffic-refresh',
        forceRefresh: true,
      }),
      expect.objectContaining({
        domain: 'failed.example',
        purpose: 'traffic-refresh',
        forceRefresh: true,
      }),
    ]));
  });

  it('falls back every candidate when the collect response shape is invalid', async () => {
    const { worker, queue, logger } = makeSimilarwebWorker({ domains: ['a.example', 'b.example'] });
    fetchWithRetry.mockResolvedValueOnce(similarwebResponse({ data: { results: 'invalid' } }, 202));

    await worker.process({
      jobId: 'seed', domain: '', traceId: 'trc-invalid', phase: 'traffic',
      purpose: 'traffic-similarweb-collect-seed',
    });

    const [payloads] = queue.enqueueBulk.mock.calls[0];
    expect(payloads).toHaveLength(2);
    expect(payloads.every((payload: any) => (
      payload.purpose === 'traffic-refresh' && payload.forceRefresh === true
    ))).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'similarweb_collect_seed_invalid_response',
    }));
  });

  it('polls pending SimilarWeb jobs every five minutes without calling traffic directly', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T01:15:00.000Z'));
    const { worker, queue } = makeSimilarwebWorker();
    fetchWithRetry.mockResolvedValueOnce(similarwebResponse({
      data: {
        job_id: 71,
        domain: 'example.com',
        status: 'pending',
        is_terminal: false,
      },
    }));

    await worker.process({
      jobId: 'check-1', domain: 'example.com', traceId: 'trc-check', phase: 'traffic',
      purpose: 'traffic-similarweb-followup-check', similarwebJobId: 71,
      followupAttempt: 1, followupDeadlineAt: '2026-08-17T01:45:00.000Z',
    });

    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'traffic-similarweb-check-example.com-71-2',
      purpose: 'traffic-similarweb-followup-check',
      followupAttempt: 2,
      delayMs: 5 * 60 * 1000,
    }), 'traffic');
  });

  it.each([
    ['completed', 'similarweb_followup_completed'],
    ['failed', 'similarweb_followup_failed'],
  ])('enqueues one stable forced traffic refresh for %s jobs', async (status, event) => {
    const { worker, queue, logger } = makeSimilarwebWorker();
    fetchWithRetry.mockResolvedValue(similarwebResponse({
      data: {
        job_id: 72,
        domain: 'example.com',
        status,
        is_terminal: true,
      },
    }));
    const payload = {
      jobId: 'check-1', domain: 'example.com', traceId: 'trc-terminal', phase: 'traffic' as const,
      purpose: 'traffic-similarweb-followup-check' as const, similarwebJobId: 72,
      followupAttempt: 1, followupDeadlineAt: '2099-01-01T00:00:00.000Z',
    };

    await worker.process(payload);
    await worker.process(payload);

    expect(queue.enqueue).toHaveBeenCalledTimes(2);
    expect(queue.enqueue.mock.calls[0][0]).toMatchObject({
      jobId: 'traffic-similarweb-terminal-example.com-72',
      purpose: 'traffic-refresh',
      forceRefresh: true,
    });
    expect(queue.enqueue.mock.calls[1][0].jobId).toBe(queue.enqueue.mock.calls[0][0].jobId);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event }));
  });

  it('times out a non-terminal job at 45 minutes and enters fallback once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T01:45:00.000Z'));
    const { worker, queue, logger } = makeSimilarwebWorker();
    fetchWithRetry.mockResolvedValueOnce(similarwebResponse({
      data: {
        job_id: 73,
        domain: 'example.com',
        status: 'processing',
        is_terminal: false,
      },
    }));

    await worker.process({
      jobId: 'check-7', domain: 'example.com', traceId: 'trc-timeout', phase: 'traffic',
      purpose: 'traffic-similarweb-followup-check', similarwebJobId: 73,
      followupAttempt: 7, followupDeadlineAt: '2026-08-17T01:45:00.000Z',
    });

    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'traffic-similarweb-terminal-example.com-73',
      purpose: 'traffic-refresh',
      forceRefresh: true,
    }), 'traffic');
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'similarweb_followup_timeout',
    }));
  });

  it.each([401, 403])('does not poll again after SimilarWeb auth HTTP %s', async (status) => {
    const { worker, queue, logger } = makeSimilarwebWorker();
    fetchWithRetry.mockRejectedValueOnce(new Error(`HTTP_${status}`));

    await worker.process({
      jobId: 'check-auth', domain: 'example.com', traceId: 'trc-auth', phase: 'traffic',
      purpose: 'traffic-similarweb-followup-check', similarwebJobId: 74,
      followupAttempt: 1, followupDeadlineAt: '2099-01-01T00:00:00.000Z',
    });

    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'traffic-similarweb-terminal-example.com-74',
      purpose: 'traffic-refresh',
      forceRefresh: true,
    }), 'traffic');
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'similarweb_followup_auth_error',
      response_status: status,
    }));
  });

  it('rechecks retry-exhausted 5xx failures before deadline and falls back on 404', async () => {
    const { worker, queue, logger } = makeSimilarwebWorker();
    const basePayload = {
      domain: 'example.com', traceId: 'trc-http', phase: 'traffic' as const,
      purpose: 'traffic-similarweb-followup-check' as const, similarwebJobId: 75,
      followupAttempt: 1, followupDeadlineAt: '2099-01-01T00:00:00.000Z',
    };
    fetchWithRetry.mockRejectedValueOnce(new Error('HTTP_503'));
    await worker.process({ ...basePayload, jobId: 'check-5xx' });
    expect(queue.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      purpose: 'traffic-similarweb-followup-check',
      followupAttempt: 2,
    }), 'traffic');

    fetchWithRetry.mockRejectedValueOnce(new Error('HTTP_404'));
    await worker.process({ ...basePayload, jobId: 'check-404' });
    expect(queue.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      jobId: 'traffic-similarweb-terminal-example.com-75',
      purpose: 'traffic-refresh',
    }), 'traffic');
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'similarweb_followup_http_terminal',
      response_status: 404,
    }));
  });

  it('falls back after a network timeout at the follow-up deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T01:45:00.000Z'));
    const { worker, queue, logger } = makeSimilarwebWorker();
    fetchWithRetry.mockRejectedValueOnce(new Error('UND_ERR_CONNECT_TIMEOUT'));

    await worker.process({
      jobId: 'check-network-deadline', domain: 'example.com', traceId: 'trc-network',
      phase: 'traffic', purpose: 'traffic-similarweb-followup-check', similarwebJobId: 76,
      followupAttempt: 7, followupDeadlineAt: '2026-08-17T01:45:00.000Z',
    });

    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'traffic-similarweb-terminal-example.com-76',
      purpose: 'traffic-refresh',
      forceRefresh: true,
    }), 'traffic');
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'similarweb_followup_timeout',
      reason: 'request_failed_at_deadline',
    }));
  });

  it('falls back when a job response has mismatched identity or terminal semantics', async () => {
    const { worker, queue, logger } = makeSimilarwebWorker();
    fetchWithRetry.mockResolvedValueOnce(similarwebResponse({
      data: {
        job_id: 77,
        domain: 'other.example',
        status: 'completed',
        is_terminal: false,
      },
    }));

    await worker.process({
      jobId: 'check-invalid-job', domain: 'example.com', traceId: 'trc-invalid-job',
      phase: 'traffic', purpose: 'traffic-similarweb-followup-check', similarwebJobId: 77,
      followupAttempt: 1, followupDeadlineAt: '2099-01-01T00:00:00.000Z',
    });

    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'traffic-similarweb-terminal-example.com-77',
      forceRefresh: true,
    }), 'traffic');
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'similarweb_followup_invalid_response',
      reason: 'job_identity_or_terminal_mismatch',
    }));
  });
});
