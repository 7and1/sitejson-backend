import { describe, expect, it, vi } from 'vitest';
import { IngestService } from '../ingest-service.js';
import { InMemoryCrawlTargetRepository } from '../../storage/in-memory.js';
import { QUEUE_NAMES } from '../../queue/names.js';
import type { JobQueue, QueueCounts, QueueCountsMap, QueueJobPayload, RepeatableJobOptions } from '../../queue/interfaces.js';
import type { QueueName } from '../../queue/names.js';
import { createLogger } from '../../observability/logger.js';

class FakeQueue implements JobQueue {
  public readonly bulkCalls: Array<{ queueName: QueueName; payloads: QueueJobPayload[] }> = [];

  async enqueue(): Promise<void> {}

  async enqueueBulk(payloads: QueueJobPayload[], queueName: QueueName): Promise<void> {
    this.bulkCalls.push({ queueName, payloads });
  }

  async addRepeatable(_queueName: QueueName, _options: RepeatableJobOptions): Promise<void> {}

  async consume(_queueName: QueueName, _handler: (payload: QueueJobPayload) => Promise<void>): Promise<void> {}

  async getCounts(): Promise<QueueCounts> {
    return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 };
  }

  async getAllCounts(): Promise<QueueCountsMap> {
    return {
      ingest: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 },
      browser_realtime: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 },
      browser: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 },
      async: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 },
      radar: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 },
      traffic: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 },
      whois: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 },
    };
  }

  async retryFailed() {
    return 0;
  }

  async healthCheck() {
    return true;
  }
}

describe('IngestService.enqueueBatch', () => {
  it('normalizes, deduplicates and enqueues in bulk', async () => {
    const queue = new FakeQueue();
    const crawlTargets = new InMemoryCrawlTargetRepository();
    const logger = createLogger('error');
    const logSpy = vi.spyOn(logger, 'info');

    const service = new IngestService(queue, crawlTargets, logger);
    const result = await service.enqueueBatch({
      domains: ['Example.com', 'example.com', 'test.org', 'invalid domain'],
      traceId: 'trace-1',
      source: 'api',
      priority: 'high',
    });

    expect(result.accepted).toEqual(['example.com', 'test.org']);
    expect(result.invalid).toEqual(['invalid domain']);
    expect(result.skipped).toEqual(['example.com']);

    expect(queue.bulkCalls.length).toBe(1);
    expect(queue.bulkCalls[0].queueName).toBe(QUEUE_NAMES.ingest);
    expect(queue.bulkCalls[0].payloads.length).toBe(2);
    expect(queue.bulkCalls[0].payloads.every((item) => item.priority === 'high')).toBe(true);
    expect(queue.bulkCalls[0].payloads.every((item) => item.dispatchLane === 'background')).toBe(true);
    expect(logSpy).toHaveBeenCalledOnce();
  });
});
