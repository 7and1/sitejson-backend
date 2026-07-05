import type { TaxonomyTriggerReason } from '../core/types.js';
import type { Logger } from '../observability/logger.js';
import type { QueueJobPayload } from '../queue/interfaces.js';
import type { JobQueue } from '../queue/interfaces.js';
import { QUEUE_NAMES, type QueueName } from '../queue/names.js';
import type { CrawlTargetRepository, JobRepository, SiteRepository } from '../storage/interfaces.js';
import type { Orchestrator } from '../core/orchestrator.js';
import { computeContentHash } from '../services/content-hash.js';
import { buildAiSeedSignals } from '../services/ai-seed-signals.js';
import { notifyAnalyzeCompleted, notifyAnalyzeFailed } from '../services/analyze-webhook.js';
import { randomUUID } from 'node:crypto';

export class BrowserWorker {
  constructor(
    private readonly queue: JobQueue,
    private readonly sites: SiteRepository,
    private readonly crawlTargets: CrawlTargetRepository,
    private readonly jobs: JobRepository,
    private readonly orchestrator: Orchestrator,
    private readonly logger: Logger,
    private readonly taxonomyPromptVersion = 1,
    private readonly queueName: QueueName = QUEUE_NAMES.browser,
  ) {}

  private resolveTriggerReason(input: {
    forceAi?: boolean;
    skipAi?: boolean;
    hasTaxonomy: boolean;
    promptVersionChanged: boolean;
    hashChanged: boolean;
  }): TaxonomyTriggerReason | null {
    if (input.skipAi) return null;
    if (input.forceAi) return 'force_ai';
    if (!input.hasTaxonomy) return 'first_run';
    if (input.promptVersionChanged) return 'prompt_upgrade';
    if (input.hashChanged) return 'hash_changed';
    return null;
  }

  async process(payload: QueueJobPayload): Promise<void> {
    const { domain, traceId, crawlJobId } = payload;
    const isAiReclassify = payload.aiReclassify === true;

    try {
      if (crawlJobId) {
        await this.jobs.markRunning(
          crawlJobId,
          isAiReclassify ? 'ai_reclassify_running' : 'browser_running',
          40,
        );
      }

      const [previous, crawlTarget] = await Promise.all([
        this.sites.getByDomain(domain),
        this.crawlTargets.getByDomain(domain),
      ]);
      const isHighValue = payload.isHighValue ?? crawlTarget?.isHighValue;
      const radarRank = crawlTarget?.radarRank;
      const aiSeedSignals = isAiReclassify ? buildAiSeedSignals(domain, previous) : undefined;
      const screenshotUrl = isAiReclassify ? (previous?.visual?.screenshotUrl ?? undefined) : undefined;
      const effectiveForceAi = isAiReclassify ? true : payload.forceAi;
      const effectiveSkipAi = isAiReclassify ? false : payload.skipAi;

      const report = await this.orchestrator.analyze(domain, traceId, {
        phase: 'browser',
        forceAi: effectiveForceAi,
        skipAi: effectiveSkipAi,
        forceRefresh: payload.forceRefresh,
        aiReclassify: isAiReclassify,
        aiSeedSignals,
        screenshotUrl,
        isHighValue,
        radarRank,
      });

      await this.sites.upsert(report, { previousReport: previous });
      if (!isAiReclassify) {
        await this.crawlTargets.markLayerResult(domain, 'browser', 'success');
      }

      const contentHash = isAiReclassify
        ? crawlTarget?.lastContentHash
        : computeContentHash({
            title: report.meta?.title,
            description: report.meta?.description,
            primaryH1: report._meta?.html?.primary_h1,
            contentLength: report._meta?.html?.length,
          });
      const promptVersionChanged = Boolean(
        typeof crawlTarget?.taxonomyPromptVersion === 'number'
          && crawlTarget.taxonomyPromptVersion < this.taxonomyPromptVersion,
      );
      const hashChanged = Boolean(
        contentHash
          && crawlTarget?.lastContentHash
          && crawlTarget.lastContentHash !== contentHash,
      );
      const shouldSkipAsyncAi = Boolean(
        payload.skipAi
          || (
            contentHash
            && crawlTarget?.lastContentHash === contentHash
            && crawlTarget?.taxonomyData
            && !promptVersionChanged
          ),
      );
      const lastContentHashPatch = isAiReclassify
        ? contentHash ?? undefined
        : contentHash ?? null;

      // Save taxonomy if AI ran
      if (report.taxonomy) {
        const hasTaxonomy = Boolean(crawlTarget?.taxonomyData);

        const triggerReason = this.resolveTriggerReason({
          forceAi: effectiveForceAi,
          skipAi: effectiveSkipAi,
          hasTaxonomy,
          promptVersionChanged,
          hashChanged,
        });

        await this.crawlTargets.update(domain, {
          taxonomyData: {
            iabCategory: report.taxonomy.iabCategory ?? 'Uncategorized',
            iabSubCategory: report.taxonomy.iabSubCategory ?? 'General',
            confidence: typeof report.taxonomy.confidence === 'number' ? report.taxonomy.confidence : 0.5,
            tags: Array.isArray(report.taxonomy.tags) ? report.taxonomy.tags : [],
          },
          taxonomyUpdatedAt: new Date().toISOString(),
          taxonomyModel: 'codex',
          taxonomyPromptVersion: this.taxonomyPromptVersion,
          taxonomyLastTriggerReason: triggerReason ?? undefined,
          taxonomySourceLane: 'browser',
          lastContentHash: lastContentHashPatch,
        });
      } else {
        if (!isAiReclassify) {
          await this.crawlTargets.update(domain, {
            lastContentHash: lastContentHashPatch,
          });
        }
      }

      // Auto-enqueue async lane for background fill (dns, ads, publisher, files, ai)
      if (!isAiReclassify) {
        const asyncScreenshotUrl = report.visual?.screenshotUrl ?? undefined;
        await this.queue.enqueue({
          jobId: randomUUID(),
          domain,
          traceId,
          parentJobId: payload.jobId,
          source: 'system',
          phase: QUEUE_NAMES.async,
          purpose: 'async-fill',
          screenshotUrl: asyncScreenshotUrl,
          forceRefresh: payload.forceRefresh,
          skipAi: shouldSkipAsyncAi,
          contentHash: contentHash ?? undefined,
        }, QUEUE_NAMES.async);
      }

      if (crawlJobId) {
        await this.jobs.markCompleted(
          crawlJobId,
          isAiReclassify ? 'ai_reclassify_completed' : 'browser_completed',
          100,
        );
        if (!isAiReclassify) {
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
            stage: 'browser_completed',
          });
        }
      }

      this.logger.info({
        trace_id: traceId,
        domain,
        module: 'browser-worker',
        event: isAiReclassify ? 'ai_reclassify_completed' : 'browser_completed',
        has_taxonomy: Boolean(report.taxonomy),
      });
    } catch (error) {
      if (!isAiReclassify) {
        await this.crawlTargets.markLayerResult(domain, 'browser', 'failed');
      }
      if (crawlJobId) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await this.jobs.markFailed(
          crawlJobId,
          errorMessage,
          isAiReclassify ? 'ai_reclassify_failed' : 'browser_failed',
        );
        if (!isAiReclassify) {
          await notifyAnalyzeFailed({ logger: this.logger }, {
            webhookUrl: payload.webhookUrl,
            jobId: crawlJobId,
            domain,
            traceId,
            priority: payload.priority,
            stage: 'browser_failed',
            errorMessage,
          });
        }
      }
      this.logger.error({
        trace_id: traceId,
        domain,
        module: 'browser-worker',
        event: isAiReclassify ? 'ai_reclassify_failed' : 'browser_failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async start(): Promise<void> {
    await this.queue.consume(this.queueName, async (payload) => {
      await this.process(payload);
    });
  }
}
