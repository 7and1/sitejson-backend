import type { Logger } from '../observability/logger.js';
import type { CrawlTargetRepository, SiteRepository } from '../storage/interfaces.js';
import { buildSiteReportResponse } from './site-report-response.js';

type AnalyzeWebhookJob = {
  jobId: string | null;
  domain: string;
  traceId: string;
  priority?: 'normal' | 'high';
  stage?: string;
};

type AnalyzeWebhookDeps = {
  sites: SiteRepository;
  crawlTargets: CrawlTargetRepository;
  logger: Logger;
};

type CompletedWebhookBody = {
  event: 'site.analyze.completed';
  data: {
    job: {
      job_id: string | null;
      status: 'completed';
      priority?: 'normal' | 'high';
      stage?: string;
    };
    site: Awaited<ReturnType<typeof buildSiteReportResponse>>['data'];
  };
  meta: {
    trace_id: string;
  };
};

type FailedWebhookBody = {
  event: 'site.analyze.failed';
  data: {
    job: {
      job_id: string | null;
      status: 'failed';
      stage?: string;
      error: {
        message: string;
      };
    };
    domain: string;
  };
  meta: {
    trace_id: string;
  };
};

const WEBHOOK_TIMEOUT_MS = 5000;

const postWebhook = async (
  webhookUrl: string | undefined,
  event: CompletedWebhookBody['event'] | FailedWebhookBody['event'],
  traceId: string,
  body: CompletedWebhookBody | FailedWebhookBody,
): Promise<void> => {
  if (!webhookUrl) {
    return;
  }

  await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sitejson-event': event,
      'x-sitejson-trace-id': traceId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
};

export const notifyAnalyzeCompleted = async (
  deps: AnalyzeWebhookDeps,
  input: AnalyzeWebhookJob & { webhookUrl?: string },
): Promise<void> => {
  if (!input.webhookUrl) {
    return;
  }

  const report = await deps.sites.getByDomain(input.domain);
  if (!report) {
    deps.logger.warn({
      trace_id: input.traceId,
      domain: input.domain,
      module: 'analyze-webhook',
      event: 'webhook_completed_skipped_missing_report',
      job_id: input.jobId,
    });
    return;
  }

  const site = await buildSiteReportResponse({ crawlTargets: deps.crawlTargets }, report);
  const payload: CompletedWebhookBody = {
    event: 'site.analyze.completed',
    data: {
      job: {
        job_id: input.jobId,
        status: 'completed',
        priority: input.priority,
        stage: input.stage,
      },
      site: site.data,
    },
    meta: {
      trace_id: input.traceId,
    },
  };

  try {
    await postWebhook(input.webhookUrl, payload.event, input.traceId, payload);
    deps.logger.info({
      trace_id: input.traceId,
      domain: input.domain,
      module: 'analyze-webhook',
      event: 'webhook_completed_sent',
      job_id: input.jobId,
      webhook_url: input.webhookUrl,
    });
  } catch (error) {
    deps.logger.warn({
      trace_id: input.traceId,
      domain: input.domain,
      module: 'analyze-webhook',
      event: 'webhook_completed_failed',
      job_id: input.jobId,
      webhook_url: input.webhookUrl,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const notifyAnalyzeFailed = async (
  deps: Pick<AnalyzeWebhookDeps, 'logger'>,
  input: AnalyzeWebhookJob & { webhookUrl?: string; errorMessage: string },
): Promise<void> => {
  if (!input.webhookUrl) {
    return;
  }

  const payload: FailedWebhookBody = {
    event: 'site.analyze.failed',
    data: {
      job: {
        job_id: input.jobId,
        status: 'failed',
        stage: input.stage,
        error: {
          message: input.errorMessage,
        },
      },
      domain: input.domain,
    },
    meta: {
      trace_id: input.traceId,
    },
  };

  try {
    await postWebhook(input.webhookUrl, payload.event, input.traceId, payload);
    deps.logger.info({
      trace_id: input.traceId,
      domain: input.domain,
      module: 'analyze-webhook',
      event: 'webhook_failed_sent',
      job_id: input.jobId,
      webhook_url: input.webhookUrl,
    });
  } catch (error) {
    deps.logger.warn({
      trace_id: input.traceId,
      domain: input.domain,
      module: 'analyze-webhook',
      event: 'webhook_failed_delivery_error',
      job_id: input.jobId,
      webhook_url: input.webhookUrl,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
