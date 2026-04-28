import { randomUUID } from 'node:crypto';
import type { Logger } from '../observability/logger.js';
import type { QueueJobPayload } from '../queue/interfaces.js';
import type { JobQueue } from '../queue/interfaces.js';
import { QUEUE_NAMES } from '../queue/names.js';
import type { CrawlTargetRepository, JobRepository } from '../storage/interfaces.js';

const INGEST_AUTO_FEED_PURPOSE: QueueJobPayload['purpose'] = 'ingest-auto-feed';
const AI_RETRY_FEED_PURPOSE: QueueJobPayload['purpose'] = 'ai-retry-feed';
const WATCHDOG_TICK_MS = 60_000;
const INGEST_AUTO_FEED_MAX_IDLE_MS = 7 * 60_000;
const AI_RETRY_FEED_MAX_IDLE_MS = 20 * 60_000;

const resolveBrowserQueueName = (dispatchLane?: QueueJobPayload['dispatchLane']) => {
  return dispatchLane === 'realtime'
    ? QUEUE_NAMES.browserRealtime
    : QUEUE_NAMES.browser;
};

export class IngestWorker {
  private lastAutoFeedAtMs = Date.now();
  private lastAiRetryAtMs = Date.now();
  private autoFeedWatchdogInFlight = false;
  private aiRetryWatchdogInFlight = false;

  constructor(
    private readonly queue: JobQueue,
    private readonly crawlTargets: CrawlTargetRepository,
    private readonly jobs: JobRepository,
    private readonly logger: Logger,
    private readonly ingestAutoFeedBatchSize: number = 500,
    private readonly ingestAutoFeedMaxRank: number = 100_000,
    private readonly aiRetryFeedBatchSize: number = 300,
    private readonly aiRetryFeedMaxRank: number = 300_000,
    private readonly taxonomyPromptVersion: number = 1,
  ) {}

  async process(payload: QueueJobPayload): Promise<void> {
    if (payload.purpose === INGEST_AUTO_FEED_PURPOSE) {
      await this.processIngestAutoFeed(payload.traceId);
      return;
    }

    if (payload.purpose === AI_RETRY_FEED_PURPOSE) {
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
        await this.jobs.markFailed(
          crawlJobId,
          error instanceof Error ? error.message : String(error),
          'ingest_failed',
        );
      }
      throw error;
    }
  }

  private async processIngestAutoFeed(traceId: string): Promise<void> {
    try {
    const effectiveTraceId = traceId || `trc_ingest_auto_${Date.now()}`;
    const candidates = await this.crawlTargets.claimHighRankFirstRunDomains(
      this.ingestAutoFeedBatchSize,
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

    this.logger.info({
      trace_id: effectiveTraceId,
      module: 'ingest-worker',
      event: 'ingest_auto_feed_enqueued',
      count: payloads.length,
      max_rank: this.ingestAutoFeedMaxRank,
    });
    } finally {
      this.lastAutoFeedAtMs = Date.now();
    }
  }

  private async processAiRetryFeed(traceId: string): Promise<void> {
    try {
    const effectiveTraceId = traceId || `trc_ai_retry_${Date.now()}`;
    const candidates = await this.crawlTargets.getBrowserSuccessTaxonomyMissingDomains(
      this.aiRetryFeedBatchSize,
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

    this.logger.info({
      trace_id: effectiveTraceId,
      module: 'ingest-worker',
      event: 'ai_retry_feed_enqueued',
      count: payloads.length,
      max_rank: this.aiRetryFeedMaxRank,
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

    if (!this.autoFeedWatchdogInFlight && now - this.lastAutoFeedAtMs >= INGEST_AUTO_FEED_MAX_IDLE_MS) {
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

    if (!this.aiRetryWatchdogInFlight && now - this.lastAiRetryAtMs >= AI_RETRY_FEED_MAX_IDLE_MS) {
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
