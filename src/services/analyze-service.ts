import { randomUUID } from 'node:crypto';
import type { Logger } from '../observability/logger.js';
import type { JobQueue } from '../queue/interfaces.js';
import { QUEUE_NAMES } from '../queue/names.js';
import type { CrawlTargetRepository, JobRepository, SiteRepository } from '../storage/interfaces.js';
import { normalizeDomain } from './domain.js';
import type { JobPriority } from '../core/types.js';

const DEFAULT_ENQUEUE_ERROR = 'QUEUE_ENQUEUE_FAILED';
const MAX_JOB_ERROR_LENGTH = 256;

const formatEnqueueError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim();
  if (!trimmed) {
    return DEFAULT_ENQUEUE_ERROR;
  }

  return trimmed.slice(0, MAX_JOB_ERROR_LENGTH);
};

export class AnalyzeService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly sites: SiteRepository,
    private readonly crawlTargets: CrawlTargetRepository,
    private readonly queue: JobQueue,
    private readonly logger: Logger,
    private readonly freshnessTtlSec: number,
    private readonly promptVersion: number,
    private readonly defaultSkipAi: boolean,
  ) {}

  async schedule(
    domainInput: string,
    forceRefresh = false,
    forceAi = false,
    priority: JobPriority = 'normal',
    skipAi = this.defaultSkipAi,
  ) {
    const domain = normalizeDomain(domainInput);
    await this.crawlTargets.upsert(domain, {
      priority: priority === 'high' ? 10 : 1,
    });

    if (!forceRefresh) {
      const existingReport = await this.sites.getByDomain(domain);
      if (existingReport && !this.isStale(existingReport.updatedAt)) {
        return {
          accepted: true,
          reason: 'ALREADY_FRESH' as const,
          jobId: null,
        };
      }
    }

    const now = new Date().toISOString();
    const jobId = `job_${randomUUID()}`;
    const traceId = `trc_${randomUUID()}`;
    const newJob = {
      id: jobId,
      domain,
      status: 'pending' as const,
      priority,
      progress: 0,
      stage: 'queued' as const,
      traceId,
      createdAt: now,
      updatedAt: now,
    };

    const createResult = await this.jobs.createPendingIfAbsent(newJob);
    if (!createResult.created) {
      return {
        accepted: false,
        reason: 'JOB_ALREADY_RUNNING' as const,
        jobId: createResult.existingJobId ?? jobId,
      };
    }

    try {
      await this.queue.enqueue({
        jobId,
        crawlJobId: jobId,
        domain,
        traceId,
        dispatchLane: 'realtime',
        forceAi,
        skipAi,
        taxonomyPromptVersion: this.promptVersion,
        forceRefresh,
        priority,
        source: 'api',
        phase: QUEUE_NAMES.ingest,
        purpose: 'analysis',
      }, QUEUE_NAMES.ingest);
    } catch (error) {
      const errorMessage = formatEnqueueError(error);

      try {
        await this.jobs.markFailed(jobId, errorMessage, 'enqueue_failed');
      } catch (markError) {
        this.logger.error({
          trace_id: traceId,
          job_id: jobId,
          domain,
          module: 'analyze-service',
          event: 'job_mark_failed_error',
          error_message: formatEnqueueError(markError),
        });
      }

      this.logger.error({
        trace_id: traceId,
        job_id: jobId,
        domain,
        module: 'analyze-service',
        event: 'job_enqueue_failed',
        error_message: errorMessage,
      });
      throw error;
    }

    this.logger.info({
      trace_id: traceId,
      job_id: jobId,
      domain,
      module: 'analyze-service',
      event: 'job_enqueued',
    });

    return {
      accepted: true,
      reason: 'QUEUED' as const,
      jobId,
      traceId,
      priority,
    };
  }

  private isStale(updatedAtIso: string): boolean {
    const updatedAt = new Date(updatedAtIso).getTime();
    if (Number.isNaN(updatedAt)) {
      return true;
    }
    return Date.now() - updatedAt > this.freshnessTtlSec * 1000;
  }
}
