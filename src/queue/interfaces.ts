import type { QueueName } from './names.js';
import type { TaxonomyTriggerReason } from '../core/types.js';

export type QueueJobPayload = {
  jobId: string;
  crawlJobId?: string;
  domain: string;
  traceId: string;
  parentJobId?: string;
  source?: 'api' | 'ingest' | 'system';
  dispatchLane?: 'realtime' | 'background';
  priority?: 'normal' | 'high';
  phase?: QueueName;
  forceRefresh?: boolean;
  forceAi?: boolean;
  skipAi?: boolean;
  aiReclassify?: boolean;
  taxonomyPromptVersion?: number;
  taxonomyTriggerReason?: TaxonomyTriggerReason;
  contentHash?: string;
  isHighValue?: boolean;
  delayMs?: number;
  similarwebJobId?: number;
  followupAttempt?: number;
  followupDeadlineAt?: string;
  screenshotUrl?: string;
  webhookUrl?: string;
  purpose?:
    | 'analysis'
    | 'radar-sync'
    | 'browser'
    | 'async-fill'
    | 'traffic-refresh'
    | 'whois-refresh'
    | 'radar-bulk-sync'
    | 'traffic-monthly-seed'
    | 'traffic-fastlane-seed'
    | 'traffic-similarweb-collect-seed'
    | 'traffic-similarweb-followup-check'
    | 'ingest-auto-feed'
    | 'ai-retry-feed'
    | 'ai-reclassify';
};

export interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  prioritized: number;
}

export interface RedisMemorySnapshot {
  usedBytes: number | null;
  maxBytes: number | null;
  ratio: number | null;
}

export type QueueCountsMap = Record<QueueName, QueueCounts>;

export interface RepeatableJobOptions {
  pattern: string;
  purpose: QueueJobPayload['purpose'];
}

export interface ActiveJob {
  queueName: QueueName;
  jobId: string;
  startedAt: number;
}

export interface JobQueue {
  enqueue(payload: QueueJobPayload, queueName?: QueueName): Promise<void>;
  enqueueBulk(payloads: QueueJobPayload[], queueName: QueueName): Promise<void>;
  addRepeatable(queueName: QueueName, options: RepeatableJobOptions): Promise<void>;
  removeRepeatables(queueName: QueueName, purpose: QueueJobPayload['purpose']): Promise<number>;
  consume(queueName: QueueName, handler: (payload: QueueJobPayload) => Promise<void>): Promise<void>;
  getCounts(queueName?: QueueName): Promise<QueueCounts>;
  getAllCounts(): Promise<QueueCountsMap>;
  getRedisMemorySnapshot(): Promise<RedisMemorySnapshot | null>;
  retryFailed(queueName: QueueName, limit: number): Promise<number>;
  healthCheck(): Promise<boolean>;
  /** Jobs this process is executing right now (worker liveness). */
  getActiveJobs?(): ActiveJob[];
  close?(): Promise<void>;
}
