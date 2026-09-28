import { Queue, Worker, type JobsOptions, type Processor, type WorkerOptions } from 'bullmq';
import type {
  ActiveJob,
  JobQueue,
  QueueCountsMap,
  QueueJobPayload,
  RedisMemorySnapshot,
  RepeatableJobOptions,
} from './interfaces.js';
import { ALL_QUEUE_NAMES, DEFAULT_QUEUE_NAME, QUEUE_NAMES, type QueueName } from './names.js';
import { asQueueCapacityError } from './errors.js';

const FAIL_RETENTION_SECONDS = 43_200;
const BROWSER_FAIL_RETENTION_SECONDS = 86_400;

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  removeOnComplete: { age: 1800, count: 100 },
  removeOnFail: { age: FAIL_RETENTION_SECONDS, count: 200 },
  backoff: {
    type: 'exponential',
    delay: 250,
  },
};

const QUEUE_JOB_OPTIONS: Partial<Record<QueueName, JobsOptions>> = {
  [QUEUE_NAMES.browserRealtime]: {
    attempts: 2,
    removeOnComplete: { age: 1800, count: 100 },
    removeOnFail: { age: BROWSER_FAIL_RETENTION_SECONDS, count: 200 },
    backoff: { type: 'exponential', delay: 2000 },
  },
  [QUEUE_NAMES.browser]: {
    attempts: 2,
    removeOnComplete: { age: 1800, count: 100 },
    removeOnFail: { age: BROWSER_FAIL_RETENTION_SECONDS, count: 200 },
    backoff: { type: 'exponential', delay: 2000 },
  },
  [QUEUE_NAMES.async]: {
    attempts: 3,
    removeOnComplete: { age: 1800, count: 100 },
    removeOnFail: { age: FAIL_RETENTION_SECONDS, count: 200 },
    backoff: { type: 'exponential', delay: 500 },
  },
  [QUEUE_NAMES.traffic]: {
    attempts: 3,
    removeOnComplete: { age: 1800, count: 100 },
    removeOnFail: { age: FAIL_RETENTION_SECONDS, count: 200 },
    backoff: { type: 'exponential', delay: 500 },
  },
  [QUEUE_NAMES.whois]: {
    attempts: 3,
    removeOnComplete: { age: 1800, count: 100 },
    removeOnFail: { age: FAIL_RETENTION_SECONDS, count: 200 },
    backoff: { type: 'exponential', delay: 500 },
  },
};

export const getJobOptionsForQueue = (queueName: QueueName): JobsOptions => {
  return QUEUE_JOB_OPTIONS[queueName] ?? DEFAULT_JOB_OPTIONS;
};

// Worker-level settings per queue. BullMQ renews locks while a worker is alive;
// lockDuration controls how long stale active jobs can remain locked after a
// worker crash or event-loop stall.
const QUEUE_WORKER_OPTIONS: Partial<Record<QueueName, Partial<WorkerOptions>>> = {
  [QUEUE_NAMES.browserRealtime]: {
    lockDuration: 300_000,      // 5 min - realtime jobs should recover quickly
    lockRenewTime: 15_000,
    stalledInterval: 60_000,
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

export const getWorkerOptionsForQueue = (queueName: QueueName): Partial<WorkerOptions> => {
  return QUEUE_WORKER_OPTIONS[queueName] ?? {};
};

const toBullMqPriority = (p?: 'normal' | 'high'): number =>
  p === 'high' ? 1 : 5;

export const buildBullMqQueueName = (queueNamePrefix: string, queueName: QueueName): string =>
  `${queueNamePrefix}-${queueName}`;

export const buildRepeatableJobId = (
  queueName: QueueName,
  purpose: QueueJobPayload['purpose'],
): string => `${queueName}-repeatable-${purpose}`;

export class BullMqJobQueue implements JobQueue {
  private readonly queues = new Map<QueueName, Queue<QueueJobPayload>>();
  private readonly workers = new Map<QueueName, Worker<QueueJobPayload>>();
  private readonly activeJobs = new Map<string, ActiveJob>();
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
      this.queues.set(queueName, new Queue<QueueJobPayload>(buildBullMqQueueName(queueNamePrefix, queueName), {
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

    try {
      await queue.add(queueName, payload, {
        jobId: payload.jobId,
        ...jobOptions,
        priority: toBullMqPriority(payload.priority),
        ...(payload.delayMs ? { delay: payload.delayMs } : {}),
      });
    } catch (error) {
      throw asQueueCapacityError(error) ?? error;
    }
  }

  async enqueueBulk(payloads: QueueJobPayload[], queueName: QueueName): Promise<void> {
    if (payloads.length === 0) return;
    const queue = this.getQueue(queueName);
    const jobOptions = getJobOptionsForQueue(queueName);

    try {
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
    } catch (error) {
      throw asQueueCapacityError(error) ?? error;
    }
  }

  async addRepeatable(queueName: QueueName, options: RepeatableJobOptions): Promise<void> {
    const queue = this.getQueue(queueName);
    const repeatableId = buildRepeatableJobId(queueName, options.purpose);

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

  async removeRepeatables(queueName: QueueName, purpose: QueueJobPayload['purpose']): Promise<number> {
    const queue = this.getQueue(queueName);
    const repeatableId = buildRepeatableJobId(queueName, purpose);
    const repeatables = await queue.getRepeatableJobs(0, -1, true);
    let removed = 0;

    for (const repeatable of repeatables) {
      const matches =
        repeatable.name === repeatableId
        || repeatable.key.includes(repeatableId)
        || repeatable.key.includes(String(purpose));

      if (!matches) {
        continue;
      }

      await queue.removeRepeatableByKey(repeatable.key);
      removed += 1;
    }

    return removed;
  }

  async consume(queueName: QueueName, handler: (payload: QueueJobPayload) => Promise<void>): Promise<void> {
    if (this.workers.has(queueName)) {
      return;
    }

    const queue = this.getQueue(queueName);
    const concurrency = this.concurrencyMap[queueName] ?? this.defaultConcurrency;

    const processor: Processor<QueueJobPayload> = async (job) => {
      const key = `${queueName}:${job.id}`;
      this.activeJobs.set(key, { queueName, jobId: String(job.id), startedAt: Date.now() });
      try {
        await handler(job.data);
      } finally {
        this.activeJobs.delete(key);
      }
      return null;
    };

    const queueWorkerOpts = getWorkerOptionsForQueue(queueName);
    const worker = new Worker<QueueJobPayload>(queue.name, processor, {
      connection: this.redisConnection,
      concurrency,
      ...queueWorkerOpts,
    });
    this.workers.set(queueName, worker);
  }

  getActiveJobs(): ActiveJob[] {
    return [...this.activeJobs.values()];
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

  async getRedisMemorySnapshot(): Promise<RedisMemorySnapshot | null> {
    try {
      const queue = this.getQueue(QUEUE_NAMES.browser);
      const client = await (queue as any).client;
      const info = String(await client.info('memory'));
      const maxMemoryResponse = await client.config('GET', 'maxmemory');

      const infoMap = new Map<string, string>();
      for (const line of info.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }
        const separatorIndex = trimmed.indexOf(':');
        if (separatorIndex <= 0) {
          continue;
        }
        infoMap.set(trimmed.slice(0, separatorIndex), trimmed.slice(separatorIndex + 1));
      }

      const usedBytes = Number.parseInt(infoMap.get('used_memory') ?? '', 10);
      let maxBytes = Number.NaN;

      if (Array.isArray(maxMemoryResponse)) {
        const maxMemoryValue = maxMemoryResponse[maxMemoryResponse.length - 1];
        maxBytes = Number.parseInt(String(maxMemoryValue ?? ''), 10);
      } else if (maxMemoryResponse && typeof maxMemoryResponse === 'object') {
        maxBytes = Number.parseInt(String((maxMemoryResponse as Record<string, unknown>).maxmemory ?? ''), 10);
      }

      const normalizedUsedBytes = Number.isFinite(usedBytes) && usedBytes >= 0 ? usedBytes : null;
      const normalizedMaxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : null;

      return {
        usedBytes: normalizedUsedBytes,
        maxBytes: normalizedMaxBytes,
        ratio: normalizedUsedBytes != null && normalizedMaxBytes != null
          ? normalizedUsedBytes / normalizedMaxBytes
          : null,
      };
    } catch {
      return null;
    }
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

export const parseRedisUrl = (redisUrl: string, passwordOverride?: string) => {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || '6379'),
    username: url.username || undefined,
    password: url.password || passwordOverride || undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
  };
};
