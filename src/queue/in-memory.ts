import type {
  JobQueue,
  QueueCountsMap,
  QueueJobPayload,
  RedisMemorySnapshot,
  RepeatableJobOptions,
} from './interfaces.js';
import { ALL_QUEUE_NAMES, DEFAULT_QUEUE_NAME, type QueueName } from './names.js';

export class InMemoryJobQueue implements JobQueue {
  private readonly buffers = new Map<QueueName, QueueJobPayload[]>();
  private readonly handlers = new Map<QueueName, (payload: QueueJobPayload) => Promise<void>>();
  private readonly draining = new Set<QueueName>();

  constructor() {
    for (const queueName of ALL_QUEUE_NAMES) {
      this.buffers.set(queueName, []);
    }
  }

  private getBuffer(queueName: QueueName): QueueJobPayload[] {
    const buffer = this.buffers.get(queueName);
    if (!buffer) {
      throw new Error(`Unknown queue: ${queueName}`);
    }
    return buffer;
  }

  async enqueue(payload: QueueJobPayload, queueName: QueueName = payload.phase ?? DEFAULT_QUEUE_NAME): Promise<void> {
    this.getBuffer(queueName).push(payload);
    await this.drain(queueName);
  }

  async enqueueBulk(payloads: QueueJobPayload[], queueName: QueueName): Promise<void> {
    const buffer = this.getBuffer(queueName);
    buffer.push(...payloads);
    await this.drain(queueName);
  }

  async addRepeatable(_queueName: QueueName, _options: RepeatableJobOptions): Promise<void> {
    // noop in memory — repeatable jobs are a BullMQ feature
  }

  async removeRepeatables(_queueName: QueueName, _purpose: QueueJobPayload['purpose']): Promise<number> {
    return 0;
  }

  async consume(queueName: QueueName, handler: (payload: QueueJobPayload) => Promise<void>): Promise<void> {
    this.handlers.set(queueName, handler);
    await this.drain(queueName);
  }

  async getCounts(queueName: QueueName = DEFAULT_QUEUE_NAME) {
    return {
      waiting: this.getBuffer(queueName).length,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      prioritized: 0,
    };
  }

  async getAllCounts(): Promise<QueueCountsMap> {
    const entries = await Promise.all(ALL_QUEUE_NAMES.map(async (queueName) => {
      const counts = await this.getCounts(queueName);
      return [queueName, counts] as const;
    }));
    return Object.fromEntries(entries) as QueueCountsMap;
  }

  async getRedisMemorySnapshot(): Promise<RedisMemorySnapshot | null> {
    return null;
  }

  async retryFailed(_queueName: QueueName, _limit: number): Promise<number> {
    return 0;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  private async drain(queueName: QueueName): Promise<void> {
    const handler = this.handlers.get(queueName);
    if (this.draining.has(queueName) || !handler) {
      return;
    }

    const buffer = this.getBuffer(queueName);
    this.draining.add(queueName);
    try {
      while (buffer.length > 0) {
        const payload = buffer.shift();
        if (!payload) {
          break;
        }
        await handler(payload);
      }
    } finally {
      this.draining.delete(queueName);
    }
  }
}
