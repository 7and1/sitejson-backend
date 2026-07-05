import type { JobQueue } from '../queue/interfaces.js';
import { QUEUE_NAMES } from '../queue/names.js';
import type { Logger } from '../observability/logger.js';

type SchedulerEnv = {
  TRAFFIC_REFRESH_START_DAY: number;
  TRAFFIC_FASTLANE_ENABLED?: boolean;
  TRAFFIC_FASTLANE_CRON?: string;
  INGEST_AUTO_FEED_ENABLED?: boolean;
  INGEST_AUTO_FEED_CRON?: string;
  AI_RETRY_FEED_ENABLED?: boolean;
  AI_RETRY_FEED_CRON?: string;
};

export async function setupScheduledJobs(queue: JobQueue, logger: Logger, env: SchedulerEnv): Promise<void> {
  // Weekly radar bulk sync: every Monday 02:00 UTC
  await queue.addRepeatable(QUEUE_NAMES.radar, {
    pattern: '0 2 * * 1',
    purpose: 'radar-bulk-sync',
  });

  // Monthly traffic refresh seed: configured day of each month, 00:00 UTC
  const trafficDay = env.TRAFFIC_REFRESH_START_DAY;
  const trafficCron = `0 0 ${trafficDay} * *`;
  await queue.addRepeatable(QUEUE_NAMES.traffic, {
    pattern: trafficCron,
    purpose: 'traffic-monthly-seed',
  });

  const jobs = [
    'radar-bulk-sync (weekly Mon 02:00)',
    `traffic-monthly-seed (${trafficDay}th 00:00)`,
  ];

  if (env.TRAFFIC_FASTLANE_ENABLED) {
    await queue.addRepeatable(QUEUE_NAMES.traffic, {
      pattern: env.TRAFFIC_FASTLANE_CRON || '*/10 * * * *',
      purpose: 'traffic-fastlane-seed',
    });
    jobs.push(`traffic-fastlane-seed (${env.TRAFFIC_FASTLANE_CRON || '*/10 * * * *'})`);
  }

  if (env.INGEST_AUTO_FEED_ENABLED) {
    await queue.addRepeatable(QUEUE_NAMES.ingest, {
      pattern: env.INGEST_AUTO_FEED_CRON || '*/5 * * * *',
      purpose: 'ingest-auto-feed',
    });
    jobs.push(`ingest-auto-feed (${env.INGEST_AUTO_FEED_CRON || '*/5 * * * *'})`);
  } else {
    const removed = await queue.removeRepeatables(QUEUE_NAMES.ingest, 'ingest-auto-feed');
    if (removed > 0) {
      jobs.push(`ingest-auto-feed disabled (removed ${removed} legacy repeatable)`);
    }
  }

  if (env.AI_RETRY_FEED_ENABLED) {
    await queue.addRepeatable(QUEUE_NAMES.ingest, {
      pattern: env.AI_RETRY_FEED_CRON || '*/15 * * * *',
      purpose: 'ai-retry-feed',
    });
    jobs.push(`ai-retry-feed (${env.AI_RETRY_FEED_CRON || '*/15 * * * *'})`);
  } else {
    const removed = await queue.removeRepeatables(QUEUE_NAMES.ingest, 'ai-retry-feed');
    if (removed > 0) {
      jobs.push(`ai-retry-feed disabled (removed ${removed} legacy repeatable)`);
    }
  }

  logger.info({
    module: 'scheduler',
    event: 'repeatable_jobs_registered',
    jobs,
  });
}
