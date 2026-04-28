import type { Logger } from '../observability/logger.js';
import type { QueueJobPayload } from '../queue/interfaces.js';
import type { JobQueue } from '../queue/interfaces.js';
import { QUEUE_NAMES } from '../queue/names.js';
import type { SiteReport } from '../core/types.js';
import type { CrawlTargetRepository, JobRepository, SiteRepository } from '../storage/interfaces.js';
import type { Orchestrator } from '../core/orchestrator.js';
import { mergeSiteReports } from '../services/report-merge.js';

const HOUR_MS = 3_600_000;

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.trim().length > 0;
};

const hasWhoisSignal = (report: SiteReport): boolean => {
  const whois = report.trafficData?.whois;
  const hasWhoisFields = !!whois
    && (
      isNonEmptyString(whois.registrar)
      || isNonEmptyString(whois.createdAt)
      || isNonEmptyString(whois.expiresAt)
      || isNonEmptyString(whois.updatedAt)
      || (Array.isArray(whois.nameservers) && whois.nameservers.length > 0)
      || (Array.isArray(whois.status) && whois.status.length > 0)
    );

  const domainAgeYears = report.trafficData?.domainAgeYears;
  const hasDomainAge = typeof domainAgeYears === 'number' && Number.isFinite(domainAgeYears) && domainAgeYears >= 0;
  return hasWhoisFields || hasDomainAge;
};

export class WhoisWorker {
  private skipCooldownCount = 0;

  constructor(
    private readonly queue: JobQueue,
    private readonly sites: SiteRepository,
    private readonly crawlTargets: CrawlTargetRepository,
    private readonly jobs: JobRepository,
    private readonly orchestrator: Orchestrator,
    private readonly logger: Logger,
    private readonly whoisSuccessTtlHours: number = 24 * 30,
    private readonly whoisNoDataCooldownHours: number = 24 * 7,
    private readonly whoisNoDataMaxCooldownHours: number = 24 * 30,
  ) {}

  private parseTimestamp(value?: string): number | null {
    if (!value) return null;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  private resolveNoDataCooldownMs(failureCount: number): number {
    const normalizedFailures = Math.max(1, Math.trunc(failureCount));
    const baseMs = Math.max(1, Math.trunc(this.whoisNoDataCooldownHours)) * HOUR_MS;
    const maxMs = Math.max(
      baseMs,
      Math.max(1, Math.trunc(this.whoisNoDataMaxCooldownHours)) * HOUR_MS,
    );

    const cooldownMs = baseMs * 2 ** (normalizedFailures - 1);
    return Math.min(cooldownMs, maxMs);
  }

  private resolveWhoisProviderResult(report: SiteReport): {
    ok: boolean | null;
    errorCode?: string;
    hasData: boolean;
  } {
    const health = report.providerHealth?.find((item) => item.provider === 'whois.provider');
    if (!health) {
      return {
        ok: null,
        hasData: hasWhoisSignal(report),
      };
    }

    return {
      ok: health.ok,
      errorCode: health.errorCode,
      hasData: hasWhoisSignal(report),
    };
  }

  async process(payload: QueueJobPayload): Promise<void> {
    const { domain, traceId, crawlJobId } = payload;
    const now = new Date();
    const target = await this.crawlTargets.getByDomain(domain);

    if (!payload.forceRefresh) {
      const nextWhoisAtMs = this.parseTimestamp(target?.nextWhoisAt);
      if (nextWhoisAtMs !== null && now.getTime() < nextWhoisAtMs) {
        this.skipCooldownCount += 1;
        const shouldLogInfo = this.skipCooldownCount <= 5 || this.skipCooldownCount % 1000 === 0;
        (shouldLogInfo ? this.logger.info : this.logger.debug)({
          trace_id: traceId,
          domain,
          module: 'whois-worker',
          event: 'whois_skipped_cooldown',
          next_whois_at: target?.nextWhoisAt,
          skipped_count: this.skipCooldownCount,
        });
        return;
      }
    }

    try {
      if (crawlJobId) {
        await this.jobs.markRunning(crawlJobId, 'whois_running', 92);
      }

      const report = await this.orchestrator.analyze(domain, traceId, {
        phase: 'whois',
        forceRefresh: true,
        skipAi: true,
      });

      const previous = await this.sites.getByDomain(domain);
      await this.sites.upsert(mergeSiteReports(previous, report));

      const whoisProvider = this.resolveWhoisProviderResult(report);
      const previousWhoisErrorCount = target?.whoisErrorCount ?? 0;
      const shouldApplyStopLoss = whoisProvider.ok !== true || !whoisProvider.hasData;
      const noData = whoisProvider.ok === true && !whoisProvider.hasData;
      const nextWhoisAt = shouldApplyStopLoss
        ? new Date(now.getTime() + this.resolveNoDataCooldownMs(previousWhoisErrorCount + 1)).toISOString()
        : new Date(now.getTime() + Math.max(1, Math.trunc(this.whoisSuccessTtlHours)) * HOUR_MS).toISOString();

      await this.crawlTargets.update(domain, {
        lastWhoisAt: now.toISOString(),
        nextWhoisAt,
        whoisErrorCount: shouldApplyStopLoss ? previousWhoisErrorCount + 1 : 0,
      });

      if (crawlJobId) {
        await this.jobs.markRunning(crawlJobId, 'whois_completed', 96);
      }

      this.logger.info({
        trace_id: traceId,
        domain,
        module: 'whois-worker',
        event: 'whois_completed',
        provider_ok: whoisProvider.ok,
        error_code: whoisProvider.errorCode,
        has_data: whoisProvider.hasData,
        no_data: noData,
        next_whois_at: nextWhoisAt,
      });
    } catch (error) {
      const previousWhoisErrorCount = target?.whoisErrorCount ?? 0;
      const nextWhoisAt = new Date(
        now.getTime() + this.resolveNoDataCooldownMs(previousWhoisErrorCount + 1),
      ).toISOString();

      await this.crawlTargets.update(domain, {
        nextWhoisAt,
        whoisErrorCount: previousWhoisErrorCount + 1,
      });

      if (crawlJobId) {
        await this.jobs.markFailed(
          crawlJobId,
          error instanceof Error ? error.message : String(error),
          'whois_failed',
        );
      }
      this.logger.error({
        trace_id: traceId,
        domain,
        module: 'whois-worker',
        event: 'whois_failed',
        next_whois_at: nextWhoisAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async start(): Promise<void> {
    await this.queue.consume(QUEUE_NAMES.whois, async (payload) => {
      await this.process(payload);
    });
  }
}
