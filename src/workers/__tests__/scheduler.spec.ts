import { describe, expect, it, vi } from 'vitest';
import { setupScheduledJobs } from '../scheduler.js';

describe('setupScheduledJobs', () => {
  it('registers ingest auto-feed and ai-retry-feed schedules', async () => {
    const queue = {
      addRepeatable: vi.fn().mockResolvedValue(undefined),
    };

    const logger = {
      info: vi.fn(),
    };

    await setupScheduledJobs(queue as any, logger as any, {
      TRAFFIC_REFRESH_START_DAY: 10,
      TRAFFIC_FASTLANE_ENABLED: false,
      INGEST_AUTO_FEED_ENABLED: true,
      INGEST_AUTO_FEED_CRON: '*/5 * * * *',
      AI_RETRY_FEED_ENABLED: true,
      AI_RETRY_FEED_CRON: '*/15 * * * *',
    });

    expect(queue.addRepeatable).toHaveBeenCalledWith('ingest', {
      pattern: '*/5 * * * *',
      purpose: 'ingest-auto-feed',
    });
    expect(queue.addRepeatable).toHaveBeenCalledWith('ingest', {
      pattern: '*/15 * * * *',
      purpose: 'ai-retry-feed',
    });

    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      module: 'scheduler',
      event: 'repeatable_jobs_registered',
      jobs: expect.arrayContaining([
        'ingest-auto-feed (*/5 * * * *)',
        'ai-retry-feed (*/15 * * * *)',
      ]),
    }));
  });
});
