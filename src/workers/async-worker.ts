import type { Logger } from '../observability/logger.js';
import type { QueueJobPayload } from '../queue/interfaces.js';
import type { JobQueue } from '../queue/interfaces.js';
import { QUEUE_NAMES } from '../queue/names.js';
import type { CrawlTargetRepository, JobRepository, SiteRepository } from '../storage/interfaces.js';
import type { Orchestrator } from '../core/orchestrator.js';
import { mergeSiteReports } from '../services/report-merge.js';
import { buildAiSeedSignals } from '../services/ai-seed-signals.js';

export class AsyncWorker {
  constructor(
    private readonly queue: JobQueue,
    private readonly sites: SiteRepository,
    private readonly crawlTargets: CrawlTargetRepository,
    private readonly jobs: JobRepository,
    private readonly orchestrator: Orchestrator,
    private readonly logger: Logger,
    private readonly taxonomyPromptVersion = 1,
  ) {}

  async process(payload: QueueJobPayload): Promise<void> {
    const { domain, traceId, crawlJobId } = payload;

    try {
      if (crawlJobId) {
        await this.jobs.markRunning(crawlJobId, 'async_running', 80);
      }

      const previous = await this.sites.getByDomain(domain);
      const aiSeedSignals = buildAiSeedSignals(domain, previous);
      const screenshotUrl = payload.screenshotUrl ?? previous?.visual?.screenshotUrl;

      const report = await this.orchestrator.analyze(domain, traceId, {
        phase: 'async',
        aiSeedSignals,
        screenshotUrl,
        aiReclassify: true,
        forceRefresh: payload.forceRefresh,
        skipAi: payload.skipAi,
      });

      await this.sites.upsert(mergeSiteReports(previous, report));
      await this.crawlTargets.markLayerResult(domain, 'async', 'success');

      // Persist taxonomy if AI ran
      if (report.taxonomy) {
        const { iabCategory, iabSubCategory, confidence, tags } = report.taxonomy;
        await this.crawlTargets.update(domain, {
          taxonomyData: {
            iabCategory: iabCategory ?? 'Uncategorized',
            iabSubCategory: iabSubCategory ?? 'General',
            confidence: typeof confidence === 'number' ? confidence : 0.5,
            tags: Array.isArray(tags) ? tags : [],
          },
          taxonomyUpdatedAt: new Date().toISOString(),
          taxonomyModel: 'codex',
          taxonomyPromptVersion: this.taxonomyPromptVersion,
          taxonomySourceLane: 'async',
        });
      }

      if (crawlJobId) {
        await this.jobs.markCompleted(crawlJobId, 'async_completed', 100);
      }

      this.logger.info({
        trace_id: traceId,
        domain,
        module: 'async-worker',
        event: 'async_completed',
        has_taxonomy: Boolean(report.taxonomy),
      });
    } catch (error) {
      await this.crawlTargets.markLayerResult(domain, 'async', 'failed');
      if (crawlJobId) {
        await this.jobs.markFailed(
          crawlJobId,
          error instanceof Error ? error.message : String(error),
          'async_failed',
        );
      }
      this.logger.error({
        trace_id: traceId,
        domain,
        module: 'async-worker',
        event: 'async_failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async start(): Promise<void> {
    await this.queue.consume(QUEUE_NAMES.async, async (payload) => {
      await this.process(payload);
    });
  }
}
