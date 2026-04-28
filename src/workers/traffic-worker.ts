import type { Logger } from '../observability/logger.js';
import type { QueueJobPayload } from '../queue/interfaces.js';
import type { JobQueue } from '../queue/interfaces.js';
import { QUEUE_NAMES } from '../queue/names.js';
import type { SiteReport } from '../core/types.js';
import type { CrawlTargetRepository, JobRepository, SiteRepository } from '../storage/interfaces.js';
import type { Orchestrator } from '../core/orchestrator.js';
import { mergeSiteReports } from '../services/report-merge.js';

const HOUR_MS = 3_600_000;

export class TrafficWorker {
  private skipCooldownCount = 0;

  constructor(
    private readonly queue: JobQueue,
    private readonly sites: SiteRepository,
    private readonly crawlTargets: CrawlTargetRepository,
    private readonly jobs: JobRepository,
    private readonly orchestrator: Orchestrator,
    private readonly logger: Logger,
    private readonly trafficRefreshSpreadDays: number = 30,
    private readonly trafficSuccessTtlHours: number = 24 * 30,
    private readonly trafficNoDataCooldownHours: number = 24 * 7,
    private readonly trafficNoDataMaxCooldownHours: number = 24 * 30,
    private readonly fastlaneBatchSize: number = 800,
    private readonly fastlaneMaxSnapshotAgeDays: number = 30,
  ) {}

  private parseTimestamp(value?: string): number | null {
    if (!value) return null;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  private resolveNoDataCooldownMs(failureCount: number): number {
    const normalizedFailures = Math.max(1, Math.trunc(failureCount));
    const baseMs = Math.max(1, Math.trunc(this.trafficNoDataCooldownHours)) * HOUR_MS;
    const maxMs = Math.max(
      baseMs,
      Math.max(1, Math.trunc(this.trafficNoDataMaxCooldownHours)) * HOUR_MS,
    );

    const cooldownMs = baseMs * 2 ** (normalizedFailures - 1);
    return Math.min(cooldownMs, maxMs);
  }

  private resolveTrafficProviderResult(report: SiteReport): {
    ok: boolean | null;
    errorCode?: string;
    source?: string;
  } {
    const health = report.providerHealth?.find((item) => item.provider === 'traffic.provider');
    const trafficSource = report._meta?.debug?.fallback_path?.traffic;
    if (!health) {
      return { ok: null, source: trafficSource };
    }

    return {
      ok: health.ok,
      errorCode: health.errorCode,
      source: trafficSource,
    };
  }

  async process(payload: QueueJobPayload): Promise<void> {
    const { domain, traceId, crawlJobId } = payload;

    // Handle monthly seed job: query top 100K and enqueue them
    if (payload.purpose === 'traffic-monthly-seed') {
      await this.seedMonthlyTraffic(traceId);
      return;
    }

    // Handle fastlane seed job: enqueue stale/missing traffic domains immediately
    if (payload.purpose === 'traffic-fastlane-seed') {
      await this.seedFastlaneTraffic(traceId);
      return;
    }

    const now = new Date();
    const target = await this.crawlTargets.getByDomain(domain);

    if (!payload.forceRefresh) {
      const nextTrafficAtMs = this.parseTimestamp(target?.nextTrafficAt);
      if (nextTrafficAtMs !== null && now.getTime() < nextTrafficAtMs) {
        this.skipCooldownCount += 1;
        const shouldLogInfo = this.skipCooldownCount <= 5 || this.skipCooldownCount % 1000 === 0;
        (shouldLogInfo ? this.logger.info : this.logger.debug)({
          trace_id: traceId,
          domain,
          module: 'traffic-worker',
          event: 'traffic_skipped_cooldown',
          next_traffic_at: target?.nextTrafficAt,
          skipped_count: this.skipCooldownCount,
        });
        return;
      }
    }

    try {
      if (crawlJobId) {
        await this.jobs.markRunning(crawlJobId, 'traffic_running', 85);
      }

      const report = await this.orchestrator.analyze(domain, traceId, {
        phase: 'traffic',
        forceRefresh: true,
        skipAi: true,
      });

      const previous = await this.sites.getByDomain(domain);
      await this.sites.upsert(mergeSiteReports(previous, report));

      const trafficProvider = this.resolveTrafficProviderResult(report);
      const previousErrorCount = target?.errorCount ?? 0;
      const shouldApplyStopLoss = trafficProvider.ok !== true;
      const nextTrafficAt = shouldApplyStopLoss
        ? new Date(now.getTime() + this.resolveNoDataCooldownMs(previousErrorCount + 1)).toISOString()
        : new Date(now.getTime() + Math.max(1, Math.trunc(this.trafficSuccessTtlHours)) * HOUR_MS).toISOString();

      await this.crawlTargets.update(domain, {
        lastTrafficAt: now.toISOString(),
        nextTrafficAt,
        errorCount: shouldApplyStopLoss ? previousErrorCount + 1 : 0,
      });
      if (crawlJobId) {
        await this.jobs.markRunning(crawlJobId, 'traffic_completed', 95);
      }

      this.logger.info({
        trace_id: traceId,
        domain,
        module: 'traffic-worker',
        event: 'traffic_completed',
        provider_ok: trafficProvider.ok,
        error_code: trafficProvider.errorCode,
        traffic_source: trafficProvider.source,
        next_traffic_at: nextTrafficAt,
      });
    } catch (error) {
      const previousErrorCount = target?.errorCount ?? 0;
      const nextTrafficAt = new Date(
        now.getTime() + this.resolveNoDataCooldownMs(previousErrorCount + 1),
      ).toISOString();

      await this.crawlTargets.update(domain, {
        nextTrafficAt,
        errorCount: previousErrorCount + 1,
      });

      if (crawlJobId) {
        await this.jobs.markFailed(
          crawlJobId,
          error instanceof Error ? error.message : String(error),
          'traffic_failed',
        );
      }
      this.logger.error({
        trace_id: traceId,
        domain,
        module: 'traffic-worker',
        event: 'traffic_failed',
        next_traffic_at: nextTrafficAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async seedMonthlyTraffic(traceId: string): Promise<void> {
    const topDomains = await this.crawlTargets.getTopByRadarRank(100_000, {
      dueOnly: true,
    });

    if (topDomains.length === 0) {
      this.logger.info({
        trace_id: traceId,
        module: 'traffic-worker',
        event: 'monthly_seed_empty',
      });
      return;
    }

    const spreadDays = Math.max(1, Math.trunc(this.trafficRefreshSpreadDays));
    const domainsPerDay = Math.ceil(topDomains.length / spreadDays);
    const MS_PER_DAY = 86_400_000;

    const payloads: QueueJobPayload[] = topDomains.map((item, index) => {
      const dayOffset = Math.floor(index / domainsPerDay);
      return {
        jobId: `traffic-monthly-${item.domain}-${Date.now()}`,
        domain: item.domain,
        traceId,
        source: 'system' as const,
        phase: QUEUE_NAMES.traffic,
        purpose: 'traffic-refresh' as const,
        delayMs: dayOffset * MS_PER_DAY,
      };
    });

    const BATCH_SIZE = 1000;
    for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
      const batch = payloads.slice(i, i + BATCH_SIZE);
      await this.queue.enqueueBulk(batch, QUEUE_NAMES.traffic);
    }

    this.logger.info({
      trace_id: traceId,
      module: 'traffic-worker',
      event: 'monthly_seed_completed',
      count: topDomains.length,
      spread_days: spreadDays,
    });
  }

  private async seedFastlaneTraffic(traceId: string): Promise<void> {
    const domains = await this.crawlTargets.getFastlaneTrafficDomains(this.fastlaneBatchSize, {
      maxSnapshotAgeDays: this.fastlaneMaxSnapshotAgeDays,
    });

    if (domains.length === 0) {
      this.logger.debug({
        trace_id: traceId,
        module: 'traffic-worker',
        event: 'fastlane_seed_empty',
      });
      return;
    }

    const payloads: QueueJobPayload[] = domains.map((domain) => ({
      jobId: `traffic-fastlane-${domain}-${Date.now()}`,
      domain,
      traceId,
      source: 'system' as const,
      phase: QUEUE_NAMES.traffic,
      purpose: 'traffic-refresh' as const,
    }));

    const BATCH_SIZE = 1000;
    for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
      const batch = payloads.slice(i, i + BATCH_SIZE);
      await this.queue.enqueueBulk(batch, QUEUE_NAMES.traffic);
    }

    this.logger.info({
      trace_id: traceId,
      module: 'traffic-worker',
      event: 'fastlane_seed_completed',
      count: domains.length,
    });
  }

  async start(): Promise<void> {
    await this.queue.consume(QUEUE_NAMES.traffic, async (payload) => {
      await this.process(payload);
    });
  }
}
