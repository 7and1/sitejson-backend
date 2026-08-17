import type { JobQueue } from '../queue/interfaces.js';
import { QUEUE_NAMES } from '../queue/names.js';
import type { Logger } from '../observability/logger.js';

type SchedulerEnv = {
  TRAFFIC_REFRESH_START_DAY: number;
  TRAFFIC_MONTHLY_SEED_ENABLED?: boolean;
  TRAFFIC_FASTLANE_ENABLED?: boolean;
  TRAFFIC_FASTLANE_CRON?: string;
  TRAFFIC_SIMILARWEB_SEED_ENABLED?: boolean;
  TRAFFIC_SIMILARWEB_SEED_CRON?: string;
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

  const jobs = [
    'radar-bulk-sync (weekly Mon 02:00)',
  ];

  if (env.TRAFFIC_MONTHLY_SEED_ENABLED) {
    const trafficDay = env.TRAFFIC_REFRESH_START_DAY;
    const trafficCron = `0 0 ${trafficDay} * *`;
    await queue.addRepeatable(QUEUE_NAMES.traffic, {
      pattern: trafficCron,
      purpose: 'traffic-monthly-seed',
    });
    jobs.push(`traffic-monthly-seed (${trafficDay}th 00:00)`);
  } else {
    const removed = await queue.removeRepeatables(QUEUE_NAMES.traffic, 'traffic-monthly-seed');
    if (removed > 0) {
      jobs.push(`traffic-monthly-seed disabled (removed ${removed} legacy repeatable)`);
    }
  }

  if (env.TRAFFIC_FASTLANE_ENABLED) {
    await queue.addRepeatable(QUEUE_NAMES.traffic, {
      pattern: env.TRAFFIC_FASTLANE_CRON || '15 * * * *',
      purpose: 'traffic-fastlane-seed',
    });
    jobs.push(`traffic-fastlane-seed (${env.TRAFFIC_FASTLANE_CRON || '15 * * * *'})`);
  } else {
    const removed = await queue.removeRepeatables(QUEUE_NAMES.traffic, 'traffic-fastlane-seed');
    if (removed > 0) {
      jobs.push(`traffic-fastlane-seed disabled (removed ${removed} legacy repeatable)`);
    }
  }

  if (env.TRAFFIC_SIMILARWEB_SEED_ENABLED) {
    await queue.addRepeatable(QUEUE_NAMES.traffic, {
      pattern: env.TRAFFIC_SIMILARWEB_SEED_CRON || '0 * * * *',
      purpose: 'traffic-similarweb-collect-seed',
    });
    jobs.push(`traffic-similarweb-collect-seed (${env.TRAFFIC_SIMILARWEB_SEED_CRON || '0 * * * *'})`);
  } else {
    const removed = await queue.removeRepeatables(
      QUEUE_NAMES.traffic,
      'traffic-similarweb-collect-seed',
    );
    if (removed > 0) {
      jobs.push(`traffic-similarweb-collect-seed disabled (removed ${removed} legacy repeatable)`);
    }
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
