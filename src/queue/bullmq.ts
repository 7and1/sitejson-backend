import { Queue, Worker, type JobsOptions, type Processor, type WorkerOptions } from 'bullmq';
import type { JobQueue, QueueCountsMap, QueueJobPayload, RepeatableJobOptions } from './interfaces.js';
import { ALL_QUEUE_NAMES, DEFAULT_QUEUE_NAME, QUEUE_NAMES, type QueueName } from './names.js';

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  removeOnComplete: { age: 1800, count: 100 },
  removeOnFail: { age: 43200, count: 200 },
  backoff: {
    type: 'exponential',
    delay: 250,
  },
};

const QUEUE_JOB_OPTIONS: Partial<Record<QueueName, JobsOptions>> = {
  [QUEUE_NAMES.browserRealtime]: {
    attempts: 2,
    removeOnComplete: { age: 1800, count: 100 },
    removeOnFail: { age: 43200, count: 200 },
    backoff: { type: 'exponential', delay: 2000 },
  },
  [QUEUE_NAMES.browser]: {
    attempts: 2,
    removeOnComplete: { age: 1800, count: 100 },
    removeOnFail: { age: 43200, count: 200 },
    backoff: { type: 'exponential', delay: 2000 },
  },
  [QUEUE_NAMES.async]: {
    attempts: 3,
    removeOnComplete: { age: 1800, count: 100 },
    removeOnFail: { age: 43200, count: 200 },
    backoff: { type: 'exponential', delay: 500 },
  },
  [QUEUE_NAMES.traffic]: {
    attempts: 3,
    removeOnComplete: { age: 1800, count: 100 },
    removeOnFail: { age: 43200, count: 200 },
    backoff: { type: 'exponential', delay: 500 },
  },
  [QUEUE_NAMES.whois]: {
    attempts: 3,
    removeOnComplete: { age: 1800, count: 100 },
    removeOnFail: { age: 43200, count: 200 },
    backoff: { type: 'exponential', delay: 500 },
  },
};

const getJobOptionsForQueue = (queueName: QueueName): JobsOptions => {
  return QUEUE_JOB_OPTIONS[queueName] ?? DEFAULT_JOB_OPTIONS;
};

// Worker-level settings per queue.
// lockDuration must exceed the longest possible job execution time to prevent
// false "stalled" detections. Browser jobs can take 30s+ (Playwright timeout).
const QUEUE_WORKER_OPTIONS: Partial<Record<QueueName, Partial<WorkerOptions>>> = {
  [QUEUE_NAMES.browserRealtime]: {
    lockDuration: 1_200_000,
    lockRenewTime: 30_000,
    stalledInterval: 120_000,
    maxStalledCount: 2,
  },
  [QUEUE_NAMES.browser]: {
    // Browser jobs can run for many minutes on difficult domains (proxy fallback + retries + AI).
    // Keep lock long enough to avoid false stalls / "Missing lock for job" errors.
    lockDuration: 1_200_000,    // 20 min
    lockRenewTime: 30_000,      // renew every 30s to tolerate event-loop hiccups
    stalledInterval: 120_000,   // stalled check every 2 min
    maxStalledCount: 2,
  },
  [QUEUE_NAMES.async]: {
    lockDuration: 60_000,       // 1 min — HTTP provider calls with retries
    stalledInterval: 30_000,
    maxStalledCount: 2,
  },
  [QUEUE_NAMES.traffic]: {
    lockDuration: 60_000,
    stalledInterval: 30_000,
    maxStalledCount: 2,
  },
  [QUEUE_NAMES.whois]: {
    lockDuration: 60_000,
    stalledInterval: 30_000,
    maxStalledCount: 2,
  },
  [QUEUE_NAMES.radar]: {
    lockDuration: 3_600_000,    // 1 hour — bulk CSV download can be very long
    stalledInterval: 120_000,
    maxStalledCount: 1,
  },
  [QUEUE_NAMES.ingest]: {
    lockDuration: 30_000,       // 30s — ingest is lightweight dispatch
    stalledInterval: 15_000,
    maxStalledCount: 2,
  },
};

const toBullMqPriority = (p?: 'normal' | 'high'): number =>
  p === 'high' ? 1 : 5;

export class BullMqJobQueue implements JobQueue {
  private readonly queues = new Map<QueueName, Queue<QueueJobPayload>>();
  private readonly workers = new Map<QueueName, Worker<QueueJobPayload>>();
  private readonly concurrencyMap: Partial<Record<QueueName, number>>;
  private readonly defaultConcurrency: number;

  constructor(
    private readonly redisConnection: { host: string; port: number; username?: string; password?: string; tls?: object },
    private readonly queueNamePrefix: string,
    concurrencyMap: Partial<Record<QueueName, number>>,
    defaultConcurrency: number,
  ) {
    this.concurrencyMap = concurrencyMap;
    this.defaultConcurrency = defaultConcurrency;

    for (const queueName of ALL_QUEUE_NAMES) {
      this.queues.set(queueName, new Queue<QueueJobPayload>(`${queueNamePrefix}-${queueName}`, {
        connection: redisConnection,
        defaultJobOptions: getJobOptionsForQueue(queueName),
      }));
    }
  }

  private getQueue(queueName: QueueName): Queue<QueueJobPayload> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Unknown queue: ${queueName}`);
    }
    return queue;
  }

  async enqueue(payload: QueueJobPayload, queueName: QueueName = payload.phase ?? DEFAULT_QUEUE_NAME): Promise<void> {
    const queue = this.getQueue(queueName);
    const jobOptions = getJobOptionsForQueue(queueName);

    await queue.add(queueName, payload, {
      jobId: payload.jobId,
      ...jobOptions,
      priority: toBullMqPriority(payload.priority),
      ...(payload.delayMs ? { delay: payload.delayMs } : {}),
    });
  }

  async enqueueBulk(payloads: QueueJobPayload[], queueName: QueueName): Promise<void> {
    if (payloads.length === 0) return;
    const queue = this.getQueue(queueName);
    const jobOptions = getJobOptionsForQueue(queueName);

    await queue.addBulk(
      payloads.map((payload) => ({
        name: queueName,
        data: payload,
        opts: {
          jobId: payload.jobId,
          ...jobOptions,
          priority: toBullMqPriority(payload.priority),
          ...(payload.delayMs ? { delay: payload.delayMs } : {}),
        },
      })),
    );
  }

  async addRepeatable(queueName: QueueName, options: RepeatableJobOptions): Promise<void> {
    const queue = this.getQueue(queueName);
    const repeatableId = `${queueName}-repeatable-${options.purpose}`;

    await queue.add(
      repeatableId,
      { jobId: repeatableId, domain: '', traceId: '', purpose: options.purpose },
      {
        repeat: { pattern: options.pattern },
        jobId: repeatableId,
        removeOnComplete: { age: 3600, count: 50 },
        removeOnFail: { age: 86400, count: 100 },
      },
    );
  }

  async consume(queueName: QueueName, handler: (payload: QueueJobPayload) => Promise<void>): Promise<void> {
    if (this.workers.has(queueName)) {
      return;
    }

    const queue = this.getQueue(queueName);
    const concurrency = this.concurrencyMap[queueName] ?? this.defaultConcurrency;

    const processor: Processor<QueueJobPayload> = async (job) => {
      await handler(job.data);
      return null;
    };

    const queueWorkerOpts = QUEUE_WORKER_OPTIONS[queueName] ?? {};
    const worker = new Worker<QueueJobPayload>(queue.name, processor, {
      connection: this.redisConnection,
      concurrency,
      ...queueWorkerOpts,
    });
    this.workers.set(queueName, worker);
  }

  async getCounts(queueName: QueueName = DEFAULT_QUEUE_NAME) {
    const queue = this.getQueue(queueName);
    const counts = await queue.getJobCounts('wait', 'active', 'completed', 'failed', 'delayed', 'prioritized');
    return {
      waiting: counts.wait ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
      prioritized: counts.prioritized ?? 0,
    };
  }

  async getAllCounts(): Promise<QueueCountsMap> {
    const entries = await Promise.all(ALL_QUEUE_NAMES.map(async (queueName) => {
      const counts = await this.getCounts(queueName);
      return [queueName, counts] as const;
    }));

    return Object.fromEntries(entries) as QueueCountsMap;
  }

  async retryFailed(queueName: QueueName, limit: number): Promise<number> {
    if (limit <= 0) {
      return 0;
    }

    const queue = this.getQueue(queueName);
    const failedJobs = await queue.getJobs(['failed'], 0, Math.max(0, limit - 1), true);
    let retried = 0;

    for (const failedJob of failedJobs) {
      try {
        await failedJob.retry();
        retried += 1;
      } catch {
        // noop
      }
    }

    return retried;
  }

  async drain(queueName: QueueName = DEFAULT_QUEUE_NAME): Promise<void> {
    const queue = this.getQueue(queueName);
    await queue.drain();
  }

  async close(): Promise<void> {
    for (const worker of this.workers.values()) {
      await worker.close();
    }
    this.workers.clear();

    for (const queue of this.queues.values()) {
      await queue.close();
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await Promise.all(Array.from(this.queues.values()).map((queue) => queue.getJobCounts()));
      return true;
    } catch {
      return false;
    }
  }
}

export const parseRedisUrl = (redisUrl: string) => {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || '6379'),
    username: url.username || undefined,
    password: url.password || undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
  };
};
