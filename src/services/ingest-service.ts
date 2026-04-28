import { randomUUID } from 'node:crypto';
import type { Logger } from '../observability/logger.js';
import type { QueueJobPayload } from '../queue/interfaces.js';
import type { JobQueue } from '../queue/interfaces.js';
import { QUEUE_NAMES } from '../queue/names.js';
import { normalizeDomain } from './domain.js';
import type { CrawlTargetRepository } from '../storage/interfaces.js';

const priorityToNumeric = (priority: 'normal' | 'high'): number => {
  return priority === 'high' ? 10 : 1;
};

const BULK_ENQUEUE_CHUNK_SIZE = 500;

export class IngestService {
  constructor(
    private readonly queue: JobQueue,
    private readonly crawlTargets: CrawlTargetRepository,
    private readonly logger: Logger,
  ) {}

  async enqueueDomain(input: {
    domain: string;
    traceId: string;
    source?: QueueJobPayload['source'];
    priority?: 'normal' | 'high';
    forceRefresh?: boolean;
    forceAi?: boolean;
    skipAi?: boolean;
  }) {
    const domain = normalizeDomain(input.domain);
    const priority = input.priority ?? 'normal';
    const target = await this.crawlTargets.upsert(domain, {
      priority: priorityToNumeric(priority),
    });

    const jobId = `ingest_${randomUUID()}`;
    await this.queue.enqueue({
      jobId,
      domain,
      traceId: input.traceId,
      source: input.source ?? 'api',
      dispatchLane: 'background',
      priority,
      phase: QUEUE_NAMES.ingest,
      forceAi: input.forceAi,
      skipAi: input.skipAi,
      isHighValue: target.isHighValue,
      forceRefresh: input.forceRefresh,
    }, QUEUE_NAMES.ingest);

    this.logger.info({
      trace_id: input.traceId,
      job_id: jobId,
      domain,
      module: 'ingest-service',
      event: 'ingest_enqueued',
    });

    return {
      jobId,
      domain,
    };
  }

  async enqueueBatch(input: {
    domains: string[];
    traceId: string;
    source?: QueueJobPayload['source'];
    priority?: 'normal' | 'high';
    forceRefresh?: boolean;
    forceAi?: boolean;
    skipAi?: boolean;
  }) {
    const accepted: string[] = [];
    const invalid: string[] = [];
    const skipped: string[] = [];
    const normalizedDomains: string[] = [];
    const seen = new Set<string>();
    const priority = input.priority ?? 'normal';

    for (const domainInput of input.domains) {
      try {
        const domain = normalizeDomain(domainInput);
        if (seen.has(domain)) {
          skipped.push(domain);
          continue;
        }
        seen.add(domain);
        normalizedDomains.push(domain);
      } catch {
        invalid.push(domainInput);
      }
    }

    if (normalizedDomains.length > 0) {
      await this.crawlTargets.bulkUpsert(
        normalizedDomains.map((domain) => ({
          domain,
          priority: priorityToNumeric(priority),
        })),
      );

      const payloads: QueueJobPayload[] = normalizedDomains.map((domain) => ({
        jobId: `ingest_${randomUUID()}`,
        domain,
        traceId: input.traceId,
        source: input.source ?? 'api',
        dispatchLane: 'background',
        priority,
        phase: QUEUE_NAMES.ingest,
        forceAi: input.forceAi,
        skipAi: input.skipAi,
        forceRefresh: input.forceRefresh,
      }));

      for (let index = 0; index < payloads.length; index += BULK_ENQUEUE_CHUNK_SIZE) {
        const chunk = payloads.slice(index, index + BULK_ENQUEUE_CHUNK_SIZE);
        await this.queue.enqueueBulk(chunk, QUEUE_NAMES.ingest);
      }

      accepted.push(...normalizedDomains);
      this.logger.info({
        trace_id: input.traceId,
        module: 'ingest-service',
        event: 'ingest_batch_enqueued',
        accepted_count: accepted.length,
        invalid_count: invalid.length,
        skipped_count: skipped.length,
      });
    }

    return {
      accepted,
      invalid,
      skipped,
    };
  }
}
