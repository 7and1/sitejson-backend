import type { Logger } from '../observability/logger.js';
import type { QueueJobPayload } from '../queue/interfaces.js';
import type { JobQueue } from '../queue/interfaces.js';
import { QUEUE_NAMES } from '../queue/names.js';
import type { SiteReport } from '../core/types.js';
import type { CrawlTargetRepository, JobRepository, SiteRepository } from '../storage/interfaces.js';
import type { Orchestrator } from '../core/orchestrator.js';
import { fetchWithRetry } from '../providers/http.js';

const HOUR_MS = 3_600_000;
const MONTHLY_TRAFFIC_RADAR_RANK_LIMIT = 100_000;
const REDIS_SEED_HARD_STOP_RATIO = 0.85;
// The SimilarWeb service caps /collect at 50 domains per request.
const SIMILARWEB_COLLECT_REQUEST_LIMIT = 50;
// Ten browser starts at one per minute finish inside this window under normal
// conditions. Scheduling ingestion here ties it to the exact collected batch
// and avoids racing an independent fastlane repeatable at the top of the hour.
const SIMILARWEB_INGEST_FOLLOWUP_DELAY_MS = 15 * 60 * 1000;

export interface SimilarwebCollectSeedConfig {
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string;
  batchSize: number;
  maxSnapshotAgeDays: number;
  timeoutMs: number;
}

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
    private readonly fastlaneBatchSize: number = 10,
    private readonly fastlaneMaxSnapshotAgeDays: number = 30,
    private readonly monthlySeedEnabled: boolean = false,
    private readonly similarwebCollectSeed?: SimilarwebCollectSeedConfig,
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

    // Handle monthly seed job: query top 100K by Radar rank and enqueue them
    if (payload.purpose === 'traffic-monthly-seed') {
      if (!this.monthlySeedEnabled) {
        this.logger.info({
          trace_id: traceId,
          module: 'traffic-worker',
          event: 'monthly_seed_disabled',
        });
        return;
      }
      await this.seedMonthlyTraffic(traceId);
      return;
    }

    // Handle fastlane seed job: enqueue stale/missing traffic domains immediately
    if (payload.purpose === 'traffic-fastlane-seed') {
      await this.seedFastlaneTraffic(traceId);
      return;
    }

    // Handle collect seed job: ask the SimilarWeb service to collect the next
    // slice of domains. This is what feeds the collection queue — nothing else
    // does, so without it the collector idles no matter how well it works.
    if (payload.purpose === 'traffic-similarweb-collect-seed') {
      await this.seedSimilarwebCollect(traceId);
      return;
    }

    const now = new Date();
    const [previous, target] = await Promise.all([
      this.sites.getByDomain(domain),
      this.crawlTargets.getByDomain(domain),
    ]);

    if (!payload.forceRefresh) {
      const nextTrafficAtMs = this.parseTimestamp(target?.nextTrafficAt);
      if (nextTrafficAtMs !== null && now.getTime() < nextTrafficAtMs) {
        this.skipCooldownCount += 1;
        const shouldLogInfo = this.skipCooldownCount <= 5 || this.skipCooldownCount % 1000 === 0;
        this.logger[shouldLogInfo ? 'info' : 'debug']({
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

      await this.sites.upsert(report, { previousReport: previous });

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
    const redisMemory = await this.queue.getRedisMemorySnapshot();
    if (
      redisMemory?.ratio != null
      && redisMemory.maxBytes != null
      && redisMemory.usedBytes != null
      && redisMemory.ratio >= REDIS_SEED_HARD_STOP_RATIO
    ) {
      this.logger.warn({
        trace_id: traceId,
        module: 'traffic-worker',
        event: 'monthly_seed_skipped_redis_memory',
        redis_memory_ratio: redisMemory.ratio,
        redis_used_bytes: redisMemory.usedBytes,
        redis_max_bytes: redisMemory.maxBytes,
        hard_stop_ratio: REDIS_SEED_HARD_STOP_RATIO,
      });
      return;
    }

    const topDomains = await this.crawlTargets.getTopByRadarRank(MONTHLY_TRAFFIC_RADAR_RANK_LIMIT, {
      dueOnly: true,
      maxRadarRank: MONTHLY_TRAFFIC_RADAR_RANK_LIMIT,
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
        jobId: `traffic-monthly-${item.domain}`,
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
      jobId: `traffic-fastlane-${domain}`,
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

  private async seedSimilarwebCollect(traceId: string): Promise<void> {
    const config = this.similarwebCollectSeed;
    if (!config?.enabled) {
      this.logger.debug({
        trace_id: traceId,
        module: 'traffic-worker',
        event: 'similarweb_collect_seed_disabled',
      });
      return;
    }

    const baseUrl = config.baseUrl?.trim();
    const apiKey = config.apiKey?.trim();
    if (!baseUrl || !apiKey) {
      this.logger.warn({
        trace_id: traceId,
        module: 'traffic-worker',
        event: 'similarweb_collect_seed_unconfigured',
        has_base_url: Boolean(baseUrl),
        has_api_key: Boolean(apiKey),
      });
      return;
    }

    const safeBatchSize = Math.max(
      1,
      Math.min(SIMILARWEB_COLLECT_REQUEST_LIMIT, Math.trunc(config.batchSize)),
    );
    const candidates = await this.crawlTargets.getSimilarwebCollectSeedDomains(safeBatchSize, {
      maxSnapshotAgeDays: config.maxSnapshotAgeDays,
    });
    const domains = candidates.map((item) => item.domain);

    if (domains.length === 0) {
      this.logger.debug({
        trace_id: traceId,
        module: 'traffic-worker',
        event: 'similarweb_collect_seed_empty',
      });
      return;
    }

    const endpoint = `${baseUrl.replace(/\/+$/, '')}/api/v1/collect`;
    const response = await fetchWithRetry(endpoint, {
      timeoutMs: Math.max(1000, Math.trunc(config.timeoutMs)),
      retryAttempts: 2,
      retryBaseMs: 500,
      requestInit: {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ domains, priority: 'low' }),
      },
    });

    const followupPayloads: QueueJobPayload[] = domains.map((domain) => ({
      jobId: `traffic-similarweb-followup-${domain}`,
      domain,
      traceId,
      source: 'system' as const,
      phase: QUEUE_NAMES.traffic,
      purpose: 'traffic-refresh' as const,
      delayMs: SIMILARWEB_INGEST_FOLLOWUP_DELAY_MS,
    }));
    await this.queue.enqueueBulk(followupPayloads, QUEUE_NAMES.traffic);

    this.logger.info({
      trace_id: traceId,
      module: 'traffic-worker',
      event: 'similarweb_collect_seed_completed',
      count: domains.length,
      first_domain: domains[0],
      last_domain: domains[domains.length - 1],
      response_status: response.status,
      ingest_followup_delay_ms: SIMILARWEB_INGEST_FOLLOWUP_DELAY_MS,
    });
  }

  async start(): Promise<void> {
    await this.queue.consume(QUEUE_NAMES.traffic, async (payload) => {
      await this.process(payload);
    });
  }
}
