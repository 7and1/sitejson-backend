import { describe, expect, it, vi } from 'vitest';
import { setupScheduledJobs } from '../scheduler.js';

describe('setupScheduledJobs', () => {
  it('registers ingest auto-feed and ai-retry-feed schedules', async () => {
    const queue = {
      addRepeatable: vi.fn().mockResolvedValue(undefined),
      removeRepeatables: vi.fn().mockResolvedValue(0),
    };

    const logger = {
      info: vi.fn(),
    };

    await setupScheduledJobs(queue as any, logger as any, {
      TRAFFIC_REFRESH_START_DAY: 10,
      TRAFFIC_MONTHLY_SEED_ENABLED: false,
      TRAFFIC_FASTLANE_ENABLED: false,
      TRAFFIC_SIMILARWEB_SEED_ENABLED: true,
      TRAFFIC_SIMILARWEB_SEED_CRON: '0 * * * *',
      INGEST_AUTO_FEED_ENABLED: true,
      INGEST_AUTO_FEED_CRON: '*/5 * * * *',
      AI_RETRY_FEED_ENABLED: true,
      AI_RETRY_FEED_CRON: '*/15 * * * *',
    });

    expect(queue.addRepeatable).toHaveBeenCalledWith('ingest', {
      pattern: '*/5 * * * *',
      purpose: 'ingest-auto-feed',
    });
    expect(queue.addRepeatable).toHaveBeenCalledWith('traffic', {
      pattern: '0 * * * *',
      purpose: 'traffic-similarweb-collect-seed',
    });
    expect(queue.addRepeatable).not.toHaveBeenCalledWith('traffic', expect.objectContaining({
      purpose: 'traffic-monthly-seed',
    }));
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
        'traffic-similarweb-collect-seed (0 * * * *)',
      ]),
    }));
  });

  it('removes disabled ingest repeatables from BullMQ registration', async () => {
    const queue = {
      addRepeatable: vi.fn().mockResolvedValue(undefined),
      removeRepeatables: vi.fn().mockImplementation(
        async (_queueName: string, purpose: string) => {
          if (purpose === 'ingest-auto-feed') return 2;
          if (purpose === 'ai-retry-feed') return 1;
          return 0;
        },
      ),
    };

    const logger = {
      info: vi.fn(),
    };

    await setupScheduledJobs(queue as any, logger as any, {
      TRAFFIC_REFRESH_START_DAY: 10,
      TRAFFIC_MONTHLY_SEED_ENABLED: false,
      TRAFFIC_FASTLANE_ENABLED: false,
      TRAFFIC_SIMILARWEB_SEED_ENABLED: false,
      INGEST_AUTO_FEED_ENABLED: false,
      INGEST_AUTO_FEED_CRON: '*/5 * * * *',
      AI_RETRY_FEED_ENABLED: false,
      AI_RETRY_FEED_CRON: '*/15 * * * *',
    });

    expect(queue.removeRepeatables).toHaveBeenCalledWith('ingest', 'ingest-auto-feed');
    expect(queue.removeRepeatables).toHaveBeenCalledWith('ingest', 'ai-retry-feed');
    expect(queue.removeRepeatables).toHaveBeenCalledWith('traffic', 'traffic-monthly-seed');
    expect(queue.removeRepeatables).toHaveBeenCalledWith('traffic', 'traffic-fastlane-seed');
    expect(queue.removeRepeatables).toHaveBeenCalledWith(
      'traffic',
      'traffic-similarweb-collect-seed',
    );
    expect(queue.addRepeatable).not.toHaveBeenCalledWith('ingest', expect.objectContaining({
      purpose: 'ingest-auto-feed',
    }));
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      module: 'scheduler',
      event: 'repeatable_jobs_registered',
      jobs: expect.arrayContaining([
        'ingest-auto-feed disabled (removed 2 legacy repeatable)',
        'ai-retry-feed disabled (removed 1 legacy repeatable)',
      ]),
    }));
  });

  it('registers the hourly fastlane and SimilarWeb seed while leaving monthly seed off', async () => {
    const queue = {
      addRepeatable: vi.fn().mockResolvedValue(undefined),
      removeRepeatables: vi.fn().mockResolvedValue(0),
    };
    const logger = { info: vi.fn() };

    await setupScheduledJobs(queue as any, logger as any, {
      TRAFFIC_REFRESH_START_DAY: 10,
      TRAFFIC_MONTHLY_SEED_ENABLED: false,
      TRAFFIC_FASTLANE_ENABLED: true,
      TRAFFIC_FASTLANE_CRON: '15 * * * *',
      TRAFFIC_SIMILARWEB_SEED_ENABLED: true,
      TRAFFIC_SIMILARWEB_SEED_CRON: '0 * * * *',
      INGEST_AUTO_FEED_ENABLED: false,
      AI_RETRY_FEED_ENABLED: false,
    });

    expect(queue.addRepeatable).toHaveBeenCalledWith('traffic', {
      pattern: '15 * * * *',
      purpose: 'traffic-fastlane-seed',
    });
    expect(queue.addRepeatable).toHaveBeenCalledWith('traffic', {
      pattern: '0 * * * *',
      purpose: 'traffic-similarweb-collect-seed',
    });
    expect(queue.addRepeatable).not.toHaveBeenCalledWith('traffic', expect.objectContaining({
      purpose: 'traffic-monthly-seed',
    }));
  });
});
