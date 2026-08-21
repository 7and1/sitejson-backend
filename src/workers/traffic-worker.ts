import type { Logger } from '../observability/logger.js';
import type { QueueJobPayload } from '../queue/interfaces.js';
import type { JobQueue } from '../queue/interfaces.js';
import { QUEUE_NAMES } from '../queue/names.js';
import type { SiteReport } from '../core/types.js';
import type { CrawlTargetRepository, JobRepository, SiteRepository } from '../storage/interfaces.js';
import type { Orchestrator } from '../core/orchestrator.js';
import { fetchWithRetry } from '../providers/http.js';
import { SIMILARWEB_SEED_MAX_BATCH_SIZE } from '../lib/similarweb-seed.js';
import { z } from 'zod';

const HOUR_MS = 3_600_000;
const MONTHLY_TRAFFIC_RADAR_RANK_LIMIT = 100_000;
const REDIS_SEED_HARD_STOP_RATIO = 0.85;
const DEFAULT_SIMILARWEB_FOLLOWUP_INITIAL_DELAY_MS = 15 * 60 * 1000;
const DEFAULT_SIMILARWEB_FOLLOWUP_POLL_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_SIMILARWEB_FOLLOWUP_MAX_WAIT_MS = 45 * 60 * 1000;

const similarwebCollectResponseSchema = z.object({
  data: z.object({
    total: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    deduped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    results: z.array(z.object({
      domain: z.string().min(1),
      queued: z.boolean(),
      deduped: z.boolean().optional(),
      job_id: z.number().int().positive().optional(),
      priority: z.enum(['high', 'normal', 'low']).optional(),
      status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
      error: z.string().optional(),
    })),
  }),
});

const similarwebJobResponseSchema = z.object({
  data: z.object({
    job_id: z.number().int().positive(),
    domain: z.string().min(1),
    status: z.enum(['pending', 'processing', 'completed', 'failed']),
    is_terminal: z.boolean(),
  }),
});

const httpStatusFromError = (error: unknown): number | null => {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/(?:^|\b)HTTP_(\d{3})(?:\b|$)/i);
  return match ? Number.parseInt(match[1], 10) : null;
};

export interface SimilarwebCollectSeedConfig {
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string;
  batchSize: number;
  maxSnapshotAgeDays: number;
  timeoutMs: number;
  followupInitialDelayMs?: number;
  followupPollIntervalMs?: number;
  followupMaxWaitMs?: number;
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

    if (payload.purpose === 'traffic-similarweb-followup-check') {
      await this.checkSimilarwebFollowup(payload);
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
        similarweb_job_id: payload.similarwebJobId,
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
        similarweb_job_id: payload.similarwebJobId,
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

    const requestedBatchSize = Number.isFinite(config.batchSize) ? Math.trunc(config.batchSize) : 1;
    const safeBatchSize = Math.max(
      1,
      Math.min(SIMILARWEB_SEED_MAX_BATCH_SIZE, requestedBatchSize),
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
    const startedAtMs = Date.now();
    let responseStatus: number | null = null;
    let responseBody: unknown;

    try {
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
      responseStatus = response.status;
      responseBody = await response.json();
    } catch (error) {
      const fallbackPayloads = domains.map((domain) => (
        this.buildTerminalTrafficPayload(domain, traceId, undefined, startedAtMs)
      ));
      await this.queue.enqueueBulk(fallbackPayloads, QUEUE_NAMES.traffic);
      this.logger.error({
        trace_id: traceId,
        module: 'traffic-worker',
        event: 'similarweb_collect_seed_request_failed',
        count: domains.length,
        response_status: httpStatusFromError(error),
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const parsedResponse = similarwebCollectResponseSchema.safeParse(responseBody);
    if (!parsedResponse.success) {
      const fallbackPayloads = domains.map((domain) => (
        this.buildTerminalTrafficPayload(domain, traceId, undefined, startedAtMs)
      ));
      await this.queue.enqueueBulk(fallbackPayloads, QUEUE_NAMES.traffic);
      this.logger.error({
        trace_id: traceId,
        module: 'traffic-worker',
        event: 'similarweb_collect_seed_invalid_response',
        count: domains.length,
        response_status: responseStatus,
        validation_issue_count: parsedResponse.error.issues.length,
      });
      return;
    }

    const resultsByDomain = new Map<
      string,
      (typeof parsedResponse.data.data.results)[number] | null
    >();
    for (const result of parsedResponse.data.data.results) {
      const normalizedDomain = result.domain.trim().toLowerCase();
      resultsByDomain.set(
        normalizedDomain,
        resultsByDomain.has(normalizedDomain) ? null : result,
      );
    }

    const initialDelayMs = this.resolvePositiveDuration(
      config.followupInitialDelayMs,
      DEFAULT_SIMILARWEB_FOLLOWUP_INITIAL_DELAY_MS,
    );
    const maxWaitMs = this.resolvePositiveDuration(
      config.followupMaxWaitMs,
      DEFAULT_SIMILARWEB_FOLLOWUP_MAX_WAIT_MS,
    );
    const followupDeadlineAt = new Date(startedAtMs + maxWaitMs).toISOString();
    let checkCount = 0;
    let fallbackCount = 0;
    const followupPayloads: QueueJobPayload[] = domains.map((domain) => {
      const result = resultsByDomain.get(domain.toLowerCase());
      if (!result?.job_id) {
        fallbackCount += 1;
        return this.buildTerminalTrafficPayload(domain, traceId, undefined, startedAtMs);
      }

      checkCount += 1;
      return {
        jobId: this.buildFollowupCheckJobId(domain, result.job_id, 1),
        domain,
        traceId,
        source: 'system' as const,
        phase: QUEUE_NAMES.traffic,
        purpose: 'traffic-similarweb-followup-check' as const,
        similarwebJobId: result.job_id,
        followupAttempt: 1,
        followupDeadlineAt,
        delayMs: initialDelayMs,
      };
    });
    await this.queue.enqueueBulk(followupPayloads, QUEUE_NAMES.traffic);
    for (const followup of followupPayloads) {
      if (followup.purpose !== 'traffic-similarweb-followup-check') {
        continue;
      }
      this.logger.info({
        trace_id: traceId,
        domain: followup.domain,
        module: 'traffic-worker',
        event: 'similarweb_followup_scheduled',
        similarweb_job_id: followup.similarwebJobId,
        followup_attempt: 1,
        followup_deadline_at: followup.followupDeadlineAt,
      });
    }

    this.logger.info({
      trace_id: traceId,
      module: 'traffic-worker',
      event: 'similarweb_collect_seed_completed',
      count: domains.length,
      first_domain: domains[0],
      last_domain: domains[domains.length - 1],
      response_status: responseStatus,
      followup_check_count: checkCount,
      fallback_count: fallbackCount,
      followup_initial_delay_ms: initialDelayMs,
      followup_max_wait_ms: maxWaitMs,
    });
  }

  private resolvePositiveDuration(value: number | undefined, fallback: number): number {
    if (value == null || !Number.isFinite(value) || value <= 0) {
      return fallback;
    }
    return Math.max(1, Math.trunc(value));
  }

  private buildFollowupCheckJobId(domain: string, similarwebJobId: number, attempt: number): string {
    return `traffic-similarweb-check-${domain}-${similarwebJobId}-${attempt}`;
  }

  private buildTerminalTrafficPayload(
    domain: string,
    traceId: string,
    similarwebJobId?: number,
    fallbackTimestampMs = Date.now(),
  ): QueueJobPayload {
    const terminalKey = similarwebJobId
      ? String(similarwebJobId)
      : `collect-${new Date(fallbackTimestampMs).toISOString().slice(0, 13).replace(/[-T]/g, '')}`;
    return {
      jobId: `traffic-similarweb-terminal-${domain}-${terminalKey}`,
      domain,
      traceId,
      source: 'system',
      phase: QUEUE_NAMES.traffic,
      purpose: 'traffic-refresh',
      forceRefresh: true,
      ...(similarwebJobId ? { similarwebJobId } : {}),
    };
  }

  private async enqueueNextSimilarwebCheck(
    payload: QueueJobPayload,
    deadlineMs: number,
  ): Promise<void> {
    const config = this.similarwebCollectSeed;
    const similarwebJobId = payload.similarwebJobId as number;
    const nextAttempt = Math.max(1, Math.trunc(payload.followupAttempt ?? 1)) + 1;
    const pollIntervalMs = this.resolvePositiveDuration(
      config?.followupPollIntervalMs,
      DEFAULT_SIMILARWEB_FOLLOWUP_POLL_INTERVAL_MS,
    );
    const remainingMs = Math.max(1, deadlineMs - Date.now());

    await this.queue.enqueue({
      ...payload,
      jobId: this.buildFollowupCheckJobId(payload.domain, similarwebJobId, nextAttempt),
      purpose: 'traffic-similarweb-followup-check',
      followupAttempt: nextAttempt,
      delayMs: Math.min(pollIntervalMs, remainingMs),
    }, QUEUE_NAMES.traffic);
  }

  private async enqueueSimilarwebTerminal(
    payload: QueueJobPayload,
    event: 'similarweb_followup_completed'
      | 'similarweb_followup_failed'
      | 'similarweb_followup_timeout'
      | 'similarweb_followup_auth_error'
      | 'similarweb_followup_http_terminal'
      | 'similarweb_followup_invalid_response',
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.queue.enqueue(
      this.buildTerminalTrafficPayload(
        payload.domain,
        payload.traceId,
        payload.similarwebJobId,
      ),
      QUEUE_NAMES.traffic,
    );

    const log = {
      trace_id: payload.traceId,
      domain: payload.domain,
      module: 'traffic-worker',
      event,
      similarweb_job_id: payload.similarwebJobId,
      followup_attempt: payload.followupAttempt ?? 1,
      ...details,
    };
    if (event === 'similarweb_followup_auth_error') {
      this.logger.error(log);
    } else if (
      event === 'similarweb_followup_timeout'
      || event === 'similarweb_followup_http_terminal'
      || event === 'similarweb_followup_invalid_response'
    ) {
      this.logger.warn(log);
    } else {
      this.logger.info(log);
    }
  }

  private async checkSimilarwebFollowup(payload: QueueJobPayload): Promise<void> {
    const config = this.similarwebCollectSeed;
    const baseUrl = config?.baseUrl?.trim();
    const apiKey = config?.apiKey?.trim();
    const similarwebJobId = payload.similarwebJobId;
    const deadlineMs = this.parseTimestamp(payload.followupDeadlineAt);

    if (!baseUrl || !apiKey || !Number.isInteger(similarwebJobId) || similarwebJobId! <= 0 || deadlineMs === null) {
      await this.enqueueSimilarwebTerminal(payload, 'similarweb_followup_invalid_response', {
        reason: 'invalid_followup_payload_or_config',
      });
      return;
    }

    const endpoint = `${baseUrl.replace(/\/+$/, '')}/api/v1/jobs/${similarwebJobId}`;
    let responseBody: unknown;
    try {
      const response = await fetchWithRetry(endpoint, {
        timeoutMs: Math.max(1000, Math.trunc(config?.timeoutMs ?? 12000)),
        retryAttempts: 2,
        retryBaseMs: 500,
        requestInit: {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'x-api-key': apiKey,
          },
        },
      });
      responseBody = await response.json();
    } catch (error) {
      const responseStatus = httpStatusFromError(error);
      if (responseStatus === 401 || responseStatus === 403) {
        await this.enqueueSimilarwebTerminal(payload, 'similarweb_followup_auth_error', {
          response_status: responseStatus,
        });
        return;
      }
      if (responseStatus !== null && responseStatus >= 400 && responseStatus < 500) {
        await this.enqueueSimilarwebTerminal(payload, 'similarweb_followup_http_terminal', {
          response_status: responseStatus,
        });
        return;
      }
      if (Date.now() < deadlineMs) {
        await this.enqueueNextSimilarwebCheck(payload, deadlineMs);
        this.logger.warn({
          trace_id: payload.traceId,
          domain: payload.domain,
          module: 'traffic-worker',
          event: 'similarweb_followup_recheck_scheduled',
          similarweb_job_id: similarwebJobId,
          followup_attempt: payload.followupAttempt ?? 1,
          response_status: responseStatus,
          reason: 'request_failed',
        });
        return;
      }
      await this.enqueueSimilarwebTerminal(payload, 'similarweb_followup_timeout', {
        response_status: responseStatus,
        reason: 'request_failed_at_deadline',
      });
      return;
    }

    const parsedResponse = similarwebJobResponseSchema.safeParse(responseBody);
    if (!parsedResponse.success) {
      await this.enqueueSimilarwebTerminal(payload, 'similarweb_followup_invalid_response', {
        validation_issue_count: parsedResponse.error.issues.length,
      });
      return;
    }

    const job = parsedResponse.data.data;
    const terminalStatus = job.status === 'completed' || job.status === 'failed';
    if (
      job.job_id !== similarwebJobId
      || job.domain.trim().toLowerCase() !== payload.domain.toLowerCase()
      || job.is_terminal !== terminalStatus
    ) {
      await this.enqueueSimilarwebTerminal(payload, 'similarweb_followup_invalid_response', {
        reason: 'job_identity_or_terminal_mismatch',
      });
      return;
    }

    if (job.status === 'completed') {
      await this.enqueueSimilarwebTerminal(payload, 'similarweb_followup_completed');
      return;
    }
    if (job.status === 'failed') {
      await this.enqueueSimilarwebTerminal(payload, 'similarweb_followup_failed');
      return;
    }
    if (Date.now() >= deadlineMs) {
      await this.enqueueSimilarwebTerminal(payload, 'similarweb_followup_timeout', {
        upstream_status: job.status,
      });
      return;
    }

    await this.enqueueNextSimilarwebCheck(payload, deadlineMs);
    this.logger.info({
      trace_id: payload.traceId,
      domain: payload.domain,
      module: 'traffic-worker',
      event: 'similarweb_followup_recheck_scheduled',
      similarweb_job_id: similarwebJobId,
      followup_attempt: payload.followupAttempt ?? 1,
      upstream_status: job.status,
    });
  }

  async start(): Promise<void> {
    await this.queue.consume(QUEUE_NAMES.traffic, async (payload) => {
      await this.process(payload);
    });
  }
}
