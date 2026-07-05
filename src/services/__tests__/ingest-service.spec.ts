import { domainToASCII } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { IngestService } from '../ingest-service.js';
import { InMemoryCrawlTargetRepository } from '../../storage/in-memory.js';
import { QUEUE_NAMES } from '../../queue/names.js';
import { QueueCapacityError } from '../../queue/errors.js';
import type {
  JobQueue,
  QueueCounts,
  QueueCountsMap,
  QueueJobPayload,
  RedisMemorySnapshot,
  RepeatableJobOptions,
} from '../../queue/interfaces.js';
import type { QueueName } from '../../queue/names.js';

vi.mock('../domain.js', () => ({
  normalizeDomain: (input: string) => {
    const normalized = input.trim().toLowerCase();
    if (!normalized || /\s/.test(normalized)) {
      throw new Error('INVALID_DOMAIN');
    }
    const ascii = domainToASCII(normalized);
    if (!ascii) {
      throw new Error('INVALID_DOMAIN');
    }
    return ascii;
  },
}));

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  fatal() {},
};

class FakeQueue implements JobQueue {
  public readonly bulkCalls: Array<{ queueName: QueueName; payloads: QueueJobPayload[] }> = [];

  async enqueue(): Promise<void> {}

  async enqueueBulk(payloads: QueueJobPayload[], queueName: QueueName): Promise<void> {
    this.bulkCalls.push({ queueName, payloads });
  }

  async addRepeatable(_queueName: QueueName, _options: RepeatableJobOptions): Promise<void> {}

  async removeRepeatables(): Promise<number> {
    return 0;
  }

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

  async getRedisMemorySnapshot(): Promise<RedisMemorySnapshot | null> {
    return null;
  }

  async retryFailed() {
    return 0;
  }

  async healthCheck() {
    return true;
  }
}

class FailingBulkQueue extends FakeQueue {
  override async enqueueBulk(): Promise<void> {
    throw new QueueCapacityError("OOM command not allowed when used memory > 'maxmemory'.");
  }
}

describe('IngestService.enqueueBatch', () => {
  it('normalizes, deduplicates and enqueues in bulk', async () => {
    const queue = new FakeQueue();
    const crawlTargets = new InMemoryCrawlTargetRepository();
    const logSpy = vi.spyOn(noopLogger, 'info');

    const service = new IngestService(queue, crawlTargets, noopLogger as any);
    const result = await service.enqueueBatch({
      domains: ['Example.com', 'example.com', 'test.org', 'Bücher.de', 'xn--bcher-kva.de', 'invalid domain'],
      traceId: 'trace-1',
      source: 'api',
      priority: 'high',
    });

    expect(result.accepted).toEqual(['example.com', 'test.org', 'xn--bcher-kva.de']);
    expect(result.invalid).toEqual(['invalid domain']);
    expect(result.skipped).toEqual(['example.com', 'xn--bcher-kva.de']);

    expect(queue.bulkCalls.length).toBe(1);
    expect(queue.bulkCalls[0].queueName).toBe(QUEUE_NAMES.ingest);
    expect(queue.bulkCalls[0].payloads.length).toBe(3);
    expect(queue.bulkCalls[0].payloads.map((item) => item.domain)).toEqual(['example.com', 'test.org', 'xn--bcher-kva.de']);
    expect(queue.bulkCalls[0].payloads.every((item) => item.priority === 'high')).toBe(true);
    expect(queue.bulkCalls[0].payloads.every((item) => item.dispatchLane === 'background')).toBe(true);
    expect(logSpy).toHaveBeenCalledOnce();
  });

  it('preserves QueueCapacityError when background bulk enqueue is capacity-blocked', async () => {
    const queue = new FailingBulkQueue();
    const crawlTargets = new InMemoryCrawlTargetRepository();

    const service = new IngestService(queue, crawlTargets, noopLogger as any);

    await expect(service.enqueueBatch({
      domains: ['example.com'],
      traceId: 'trace-oom',
      source: 'api',
    })).rejects.toBeInstanceOf(QueueCapacityError);
  });
});
