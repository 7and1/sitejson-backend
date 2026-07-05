import { randomUUID } from 'node:crypto';
import type { Logger } from '../observability/logger.js';
import type { QueueJobPayload } from '../queue/interfaces.js';
import type { JobQueue } from '../queue/interfaces.js';
import { QUEUE_NAMES } from '../queue/names.js';
import type { CrawlTargetRepository, JobRepository, SiteRepository } from '../storage/interfaces.js';
import { notifyAnalyzeCompleted, notifyAnalyzeFailed } from '../services/analyze-webhook.js';

const INGEST_AUTO_FEED_PURPOSE: QueueJobPayload['purpose'] = 'ingest-auto-feed';
const AI_RETRY_FEED_PURPOSE: QueueJobPayload['purpose'] = 'ai-retry-feed';
const WATCHDOG_TICK_MS = 60_000;
const INGEST_AUTO_FEED_MAX_IDLE_MS = 7 * 60_000;
const AI_RETRY_FEED_MAX_IDLE_MS = 20 * 60_000;
const DEFAULT_BACKGROUND_BROWSER_MAX_QUEUE_DEPTH = 5_000;
const DEFAULT_BACKGROUND_BROWSER_DAILY_BUDGET = 10_000;
const DEFAULT_AI_RETRY_DAILY_BUDGET = 1_000;
const DEFAULT_REDIS_FEED_HARD_STOP_RATIO = 0.85;
const DEFAULT_STALE_PENDING_RELEASE_HOURS = 24;
const DEFAULT_STALE_PENDING_RELEASE_LIMIT = 5_000;
const DEFAULT_STALE_ACTIVE_JOB_HOURS = 2;
const DEFAULT_STALE_ACTIVE_JOB_LIMIT = 5_000;

const resolveBrowserQueueName = (dispatchLane?: QueueJobPayload['dispatchLane']) => {
  return dispatchLane === 'realtime'
    ? QUEUE_NAMES.browserRealtime
    : QUEUE_NAMES.browser;
};

type FeedKind = 'ingest-auto-feed' | 'ai-retry-feed';

type IngestWorkerOptions = {
  ingestAutoFeedEnabled?: boolean;
  aiRetryFeedEnabled?: boolean;
  backgroundBrowserMaxQueueDepth?: number;
  backgroundBrowserDailyBudget?: number;
  aiRetryDailyBudget?: number;
  redisFeedHardStopRatio?: number;
  stalePendingReleaseHours?: number;
  stalePendingReleaseLimit?: number;
  staleActiveJobHours?: number;
  staleActiveJobLimit?: number;
};

export class IngestWorker {
  private lastAutoFeedAtMs = Date.now();
  private lastAiRetryAtMs = Date.now();
  private autoFeedWatchdogInFlight = false;
  private aiRetryWatchdogInFlight = false;
  private activeJobReaperInFlight = false;
  private backgroundDailyBudgetDate = '';
  private backgroundBrowserEnqueuedToday = 0;
  private aiRetryEnqueuedToday = 0;

  constructor(
    private readonly queue: JobQueue,
    private readonly crawlTargets: CrawlTargetRepository,
    private readonly jobs: JobRepository,
    private readonly logger: Logger,
    private readonly ingestAutoFeedBatchSize: number = 500,
    private readonly ingestAutoFeedMaxRank: number = 1_000_000,
    private readonly aiRetryFeedBatchSize: number = 300,
    private readonly aiRetryFeedMaxRank: number = 300_000,
    private readonly taxonomyPromptVersion: number = 1,
    private readonly options: IngestWorkerOptions = {},
    private readonly sites?: SiteRepository,
  ) {}

  async process(payload: QueueJobPayload): Promise<void> {
    if (payload.purpose === INGEST_AUTO_FEED_PURPOSE) {
      if (!this.isFeedEnabled('ingest-auto-feed')) {
        this.logger.info({
          trace_id: payload.traceId,
          module: 'ingest-worker',
          event: 'ingest_auto_feed_skipped_disabled',
        });
        return;
      }
      await this.processIngestAutoFeed(payload.traceId);
      return;
    }

    if (payload.purpose === AI_RETRY_FEED_PURPOSE) {
      if (!this.isFeedEnabled('ai-retry-feed')) {
        this.logger.info({
          trace_id: payload.traceId,
          module: 'ingest-worker',
          event: 'ai_retry_feed_skipped_disabled',
        });
        return;
      }
      await this.processAiRetryFeed(payload.traceId);
      return;
    }

    const domain = payload.domain;
    const traceId = payload.traceId;
    const crawlJobId = payload.crawlJobId;

    if (!domain) {
      this.logger.warn({
        trace_id: traceId,
        module: 'ingest-worker',
        event: 'ingest_domain_missing',
        purpose: payload.purpose,
      });
      return;
    }

    try {
      if (crawlJobId) {
        await this.jobs.markRunning(crawlJobId, 'ingest_dispatching', 10);
      }

      const due = await this.crawlTargets.evaluateDue(domain, {
        forceRefresh: payload.forceRefresh,
      });

      if (!due.needsBrowser && !due.needsRadar && !due.needsAsync) {
        if (crawlJobId) {
          await this.jobs.markCompleted(crawlJobId, 'fresh_skipped', 100);
          if (this.sites) {
            await notifyAnalyzeCompleted({
              sites: this.sites,
              crawlTargets: this.crawlTargets,
              logger: this.logger,
            }, {
              webhookUrl: payload.webhookUrl,
              jobId: crawlJobId,
              domain,
              traceId,
              priority: payload.priority,
              stage: 'fresh_skipped',
            });
          }
        }

        this.logger.info({
          trace_id: traceId,
          domain,
          module: 'ingest-worker',
          event: 'all_layers_fresh_skipped',
        });
        return;
      }

      if (due.needsBrowser) {
        const rank = due.radarRank;
        const isTop100k = typeof rank === 'number' && rank > 0 && rank <= 100_000;
        const browserQueueName = resolveBrowserQueueName(payload.dispatchLane);

        await this.queue.enqueue({
          ...payload,
          parentJobId: payload.jobId,
          phase: browserQueueName,
          purpose: 'browser',
          isHighValue: due.isHighValue,
          priority: isTop100k ? 'high' : 'normal',
        }, browserQueueName);
        await this.crawlTargets.update(domain, {
          lastBrowserStatus: 'pending',
        });
      }

      if (due.needsRadar) {
        await this.queue.enqueue({
          ...payload,
          parentJobId: payload.jobId,
          phase: QUEUE_NAMES.radar,
          purpose: 'radar-sync',
        }, QUEUE_NAMES.radar);
      }

      if (due.needsAsync && !due.needsBrowser) {
        await this.queue.enqueue({
          ...payload,
          parentJobId: payload.jobId,
          phase: QUEUE_NAMES.async,
          purpose: 'async-fill',
        }, QUEUE_NAMES.async);
      }

      if (crawlJobId) {
        if (due.needsBrowser) {
          await this.jobs.markRunning(crawlJobId, 'browser_queued', 20);
        } else {
          await this.jobs.markCompleted(crawlJobId, 'background_queued', 100);
          if (this.sites) {
            await notifyAnalyzeCompleted({
              sites: this.sites,
              crawlTargets: this.crawlTargets,
              logger: this.logger,
            }, {
              webhookUrl: payload.webhookUrl,
              jobId: crawlJobId,
              domain,
              traceId,
              priority: payload.priority,
              stage: 'background_queued',
            });
          }
        }
      }

      this.logger.info({
        trace_id: traceId,
        domain,
        module: 'ingest-worker',
        event: 'layers_dispatched',
        needs_browser: due.needsBrowser,
        needs_radar: due.needsRadar,
        needs_async: due.needsAsync,
      });
    } catch (error) {
      if (crawlJobId) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await this.jobs.markFailed(
          crawlJobId,
          errorMessage,
          'ingest_failed',
        );
        await notifyAnalyzeFailed({ logger: this.logger }, {
          webhookUrl: payload.webhookUrl,
          jobId: crawlJobId,
          domain,
          traceId,
          priority: payload.priority,
          stage: 'ingest_failed',
          errorMessage,
        });
      }
      throw error;
    }
  }

  private isFeedEnabled(kind: FeedKind): boolean {
    if (kind === 'ingest-auto-feed') {
      return this.options.ingestAutoFeedEnabled ?? true;
    }

    return this.options.aiRetryFeedEnabled ?? true;
  }

  private resetDailyBudgetIfNeeded(now = new Date()): void {
    const nextDate = now.toISOString().slice(0, 10);
    if (this.backgroundDailyBudgetDate === nextDate) {
      return;
    }

    this.backgroundDailyBudgetDate = nextDate;
    this.backgroundBrowserEnqueuedToday = 0;
    this.aiRetryEnqueuedToday = 0;
  }

  private getDailyBudget(kind: FeedKind): number {
    if (kind === 'ingest-auto-feed') {
      return this.options.backgroundBrowserDailyBudget ?? DEFAULT_BACKGROUND_BROWSER_DAILY_BUDGET;
    }

    return this.options.aiRetryDailyBudget ?? DEFAULT_AI_RETRY_DAILY_BUDGET;
  }

  private getRemainingDailyBudget(kind: FeedKind): number {
    this.resetDailyBudgetIfNeeded();
    const budget = this.getDailyBudget(kind);
    const used = kind === 'ingest-auto-feed'
      ? this.backgroundBrowserEnqueuedToday
      : this.aiRetryEnqueuedToday;
    return Math.max(0, budget - used);
  }

  private consumeDailyBudget(kind: FeedKind, count: number): void {
    this.resetDailyBudgetIfNeeded();
    if (kind === 'ingest-auto-feed') {
      this.backgroundBrowserEnqueuedToday += count;
      return;
    }

    this.aiRetryEnqueuedToday += count;
  }

  private async getBackgroundBrowserQueueDepth(): Promise<{
    depth: number;
    maxDepth: number;
    waiting: number;
    delayed: number;
    prioritized: number;
    active: number;
  }> {
    const [ingestCounts, browserCounts] = await Promise.all([
      this.queue.getCounts(QUEUE_NAMES.ingest),
      this.queue.getCounts(QUEUE_NAMES.browser),
    ]);
    return {
      depth:
        ingestCounts.waiting + ingestCounts.delayed + ingestCounts.prioritized
        + browserCounts.waiting + browserCounts.delayed + browserCounts.prioritized,
      maxDepth: this.options.backgroundBrowserMaxQueueDepth ?? DEFAULT_BACKGROUND_BROWSER_MAX_QUEUE_DEPTH,
      waiting: ingestCounts.waiting + browserCounts.waiting,
      delayed: ingestCounts.delayed + browserCounts.delayed,
      prioritized: ingestCounts.prioritized + browserCounts.prioritized,
      active: ingestCounts.active + browserCounts.active,
    };
  }

  private async shouldRunBackgroundFeed(
    kind: FeedKind,
    traceId: string,
  ): Promise<{ allowed: true; remainingBudget: number } | { allowed: false }> {
    if (!this.isFeedEnabled(kind)) {
      this.logger.info({
        trace_id: traceId,
        module: 'ingest-worker',
        event: `${kind.replace(/-/g, '_')}_skipped_disabled`,
      });
      return { allowed: false };
    }

    const remainingBudget = this.getRemainingDailyBudget(kind);
    if (remainingBudget <= 0) {
      this.logger.warn({
        trace_id: traceId,
        module: 'ingest-worker',
        event: 'background_feed_skipped_daily_budget',
        feed_kind: kind,
        daily_budget: this.getDailyBudget(kind),
      });
      return { allowed: false };
    }

    const queueDepth = await this.getBackgroundBrowserQueueDepth();
    if (queueDepth.maxDepth >= 0 && queueDepth.depth >= queueDepth.maxDepth) {
      this.logger.warn({
        trace_id: traceId,
        module: 'ingest-worker',
        event: 'background_feed_skipped_queue_depth',
        feed_kind: kind,
        queue_depth: queueDepth.depth,
        max_queue_depth: queueDepth.maxDepth,
        waiting: queueDepth.waiting,
        delayed: queueDepth.delayed,
        prioritized: queueDepth.prioritized,
        active: queueDepth.active,
      });
      return { allowed: false };
    }

    const redisMemory = await this.queue.getRedisMemorySnapshot();
    const redisHardStopRatio = this.options.redisFeedHardStopRatio ?? DEFAULT_REDIS_FEED_HARD_STOP_RATIO;
    if (
      redisMemory?.ratio != null
      && redisMemory.maxBytes != null
      && redisMemory.usedBytes != null
      && redisMemory.ratio >= redisHardStopRatio
    ) {
      this.logger.warn({
        trace_id: traceId,
        module: 'ingest-worker',
        event: 'background_feed_skipped_redis_memory',
        feed_kind: kind,
        redis_memory_ratio: redisMemory.ratio,
        redis_used_bytes: redisMemory.usedBytes,
        redis_max_bytes: redisMemory.maxBytes,
        hard_stop_ratio: redisHardStopRatio,
      });
      return { allowed: false };
    }

    return {
      allowed: true,
      remainingBudget,
    };
  }

  private async processIngestAutoFeed(traceId: string): Promise<void> {
    try {
      const effectiveTraceId = traceId || `trc_ingest_auto_${Date.now()}`;
      const allowed = await this.shouldRunBackgroundFeed('ingest-auto-feed', effectiveTraceId);
      if (!allowed.allowed) {
        return;
      }

      const released = await this.releaseStalePendingFirstRunCandidates(effectiveTraceId);
      if (released > 0) {
        this.logger.info({
          trace_id: effectiveTraceId,
          module: 'ingest-worker',
          event: 'ingest_auto_feed_stale_pending_released',
          count: released,
          stale_hours: this.options.stalePendingReleaseHours ?? DEFAULT_STALE_PENDING_RELEASE_HOURS,
          max_rank: this.ingestAutoFeedMaxRank,
        });
      }

      const claimLimit = Math.max(1, Math.min(this.ingestAutoFeedBatchSize, allowed.remainingBudget));
      const candidates = await this.crawlTargets.claimHighRankFirstRunDomains(
        claimLimit,
        {
          maxRadarRank: this.ingestAutoFeedMaxRank,
        },
      );

      if (candidates.length === 0) {
        this.logger.info({
          trace_id: effectiveTraceId,
          module: 'ingest-worker',
          event: 'ingest_auto_feed_empty',
          max_rank: this.ingestAutoFeedMaxRank,
        });
        return;
      }

      const payloads: QueueJobPayload[] = candidates.map((item) => ({
        jobId: `ingest-auto-${item.domain}-${randomUUID()}`,
        domain: item.domain,
        traceId: effectiveTraceId,
        source: 'system',
        dispatchLane: 'background',
        phase: QUEUE_NAMES.ingest,
        purpose: 'analysis',
        priority: 'high',
        isHighValue: item.isHighValue,
      }));

      try {
        await this.queue.enqueueBulk(payloads, QUEUE_NAMES.ingest);
      } catch (error) {
        await this.crawlTargets.releaseClaimedFirstRunDomains(candidates.map((item) => item.domain));
        this.logger.error({
          trace_id: effectiveTraceId,
          module: 'ingest-worker',
          event: 'ingest_auto_feed_enqueue_failed',
          count: payloads.length,
          max_rank: this.ingestAutoFeedMaxRank,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      this.consumeDailyBudget('ingest-auto-feed', payloads.length);
      this.logger.info({
        trace_id: effectiveTraceId,
        module: 'ingest-worker',
        event: 'ingest_auto_feed_enqueued',
        count: payloads.length,
        max_rank: this.ingestAutoFeedMaxRank,
        remaining_daily_budget: this.getRemainingDailyBudget('ingest-auto-feed'),
      });
    } finally {
      this.lastAutoFeedAtMs = Date.now();
    }
  }

  private async releaseStalePendingFirstRunCandidates(traceId: string): Promise<number> {
    if (typeof this.crawlTargets.releaseStaleBrowserPending !== 'function') {
      return 0;
    }

    try {
      return await this.crawlTargets.releaseStaleBrowserPending({
        staleHours: this.options.stalePendingReleaseHours ?? DEFAULT_STALE_PENDING_RELEASE_HOURS,
        limit: this.options.stalePendingReleaseLimit ?? DEFAULT_STALE_PENDING_RELEASE_LIMIT,
        maxRadarRank: this.ingestAutoFeedMaxRank,
      });
    } catch (error) {
      this.logger.warn({
        trace_id: traceId,
        module: 'ingest-worker',
        event: 'ingest_auto_feed_stale_pending_release_failed',
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  private async processAiRetryFeed(traceId: string): Promise<void> {
    try {
      const effectiveTraceId = traceId || `trc_ai_retry_${Date.now()}`;
      const allowed = await this.shouldRunBackgroundFeed('ai-retry-feed', effectiveTraceId);
      if (!allowed.allowed) {
        return;
      }

      const selectLimit = Math.max(1, Math.min(this.aiRetryFeedBatchSize, allowed.remainingBudget));
      const candidates = await this.crawlTargets.getBrowserSuccessTaxonomyMissingDomains(
        selectLimit,
        {
          maxRadarRank: this.aiRetryFeedMaxRank,
          currentPromptVersion: this.taxonomyPromptVersion,
        },
      );

      if (candidates.length === 0) {
        this.logger.info({
          trace_id: effectiveTraceId,
          module: 'ingest-worker',
          event: 'ai_retry_feed_empty',
          max_rank: this.aiRetryFeedMaxRank,
        });
        return;
      }

      const payloads: QueueJobPayload[] = candidates.map((item) => ({
        jobId: `ai-reclassify-${item.domain}-${randomUUID()}`,
        domain: item.domain,
        traceId: effectiveTraceId,
        source: 'system',
        dispatchLane: 'background',
        priority: 'high',
        phase: QUEUE_NAMES.browser,
        purpose: 'ai-reclassify',
        forceAi: true,
        skipAi: false,
        aiReclassify: true,
        isHighValue: item.isHighValue,
      }));

      await this.queue.enqueueBulk(payloads, QUEUE_NAMES.browser);

      this.consumeDailyBudget('ai-retry-feed', payloads.length);
      this.logger.info({
        trace_id: effectiveTraceId,
        module: 'ingest-worker',
        event: 'ai_retry_feed_enqueued',
        count: payloads.length,
        max_rank: this.aiRetryFeedMaxRank,
        remaining_daily_budget: this.getRemainingDailyBudget('ai-retry-feed'),
      });
    } finally {
      this.lastAiRetryAtMs = Date.now();
    }
  }

  private startWatchdog(): void {
    setInterval(() => {
      void this.runWatchdogTick();
    }, WATCHDOG_TICK_MS).unref();
  }

  private async runWatchdogTick(): Promise<void> {
    const now = Date.now();

    if (!this.activeJobReaperInFlight) {
      this.activeJobReaperInFlight = true;
      const traceId = `trc_crawl_job_reaper_${now}`;
      try {
        const released = await this.jobs.releaseStaleActiveJobs({
          staleHours: this.options.staleActiveJobHours ?? DEFAULT_STALE_ACTIVE_JOB_HOURS,
          limit: this.options.staleActiveJobLimit ?? DEFAULT_STALE_ACTIVE_JOB_LIMIT,
        });
        if (released > 0) {
          this.logger.warn({
            trace_id: traceId,
            module: 'ingest-worker',
            event: 'stale_active_jobs_released',
            count: released,
            stale_hours: this.options.staleActiveJobHours ?? DEFAULT_STALE_ACTIVE_JOB_HOURS,
          });
        }
      } catch (error) {
        this.logger.error({
          trace_id: traceId,
          module: 'ingest-worker',
          event: 'stale_active_jobs_release_failed',
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.activeJobReaperInFlight = false;
      }
    }

    if (
      this.isFeedEnabled('ingest-auto-feed')
      && !this.autoFeedWatchdogInFlight
      && now - this.lastAutoFeedAtMs >= INGEST_AUTO_FEED_MAX_IDLE_MS
    ) {
      this.autoFeedWatchdogInFlight = true;
      const traceId = `trc_ingest_watchdog_${now}`;
      this.logger.warn({
        trace_id: traceId,
        module: 'ingest-worker',
        event: 'ingest_auto_feed_watchdog_triggered',
        idle_ms: now - this.lastAutoFeedAtMs,
      });
      try {
        await this.processIngestAutoFeed(traceId);
      } catch (error) {
        this.logger.error({
          trace_id: traceId,
          module: 'ingest-worker',
          event: 'ingest_auto_feed_watchdog_failed',
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.autoFeedWatchdogInFlight = false;
      }
    }

    if (
      this.isFeedEnabled('ai-retry-feed')
      && !this.aiRetryWatchdogInFlight
      && now - this.lastAiRetryAtMs >= AI_RETRY_FEED_MAX_IDLE_MS
    ) {
      this.aiRetryWatchdogInFlight = true;
      const traceId = `trc_ai_retry_watchdog_${now}`;
      this.logger.warn({
        trace_id: traceId,
        module: 'ingest-worker',
        event: 'ai_retry_feed_watchdog_triggered',
        idle_ms: now - this.lastAiRetryAtMs,
      });
      try {
        await this.processAiRetryFeed(traceId);
      } catch (error) {
        this.logger.error({
          trace_id: traceId,
          module: 'ingest-worker',
          event: 'ai_retry_feed_watchdog_failed',
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.aiRetryWatchdogInFlight = false;
      }
    }
  }

  async start(): Promise<void> {
    await this.queue.consume(QUEUE_NAMES.ingest, async (payload) => {
      await this.process(payload);
    });
    this.startWatchdog();
  }
}
