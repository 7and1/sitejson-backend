import { Queue, type Job } from 'bullmq';
import { loadEnv } from '../config/env.js';
import { buildBullMqQueueName, parseRedisUrl } from '../queue/bullmq.js';
import { QUEUE_NAMES, type QueueName } from '../queue/names.js';
import type { QueueJobPayload } from '../queue/interfaces.js';

type QueueState = 'wait' | 'prioritized' | 'delayed';
type Action = 'stats' | 'clear';
type JobClass = 'ai-reclassify' | 'ingest-auto' | 'manual-first-run' | 'legacy-background-browser' | 'other';

interface Options {
  action: Action;
  apply: boolean;
  queueName: QueueName;
  states: QueueState[];
  prefixes: Array<JobClass | 'all'>;
  limit: number | null;
  pageSize: number;
}

const DEFAULT_STATES: QueueState[] = ['wait', 'prioritized', 'delayed'];
const CLEARABLE_CLASSES = new Set<JobClass>([
  'ai-reclassify',
  'ingest-auto',
  'manual-first-run',
  'legacy-background-browser',
]);

const isLegacyBackgroundBrowserJob = (job: Job<QueueJobPayload>): boolean => {
  const data = job.data;
  return data?.source === 'system'
    && data?.dispatchLane === 'background'
    && data?.phase === QUEUE_NAMES.browser
    && data?.purpose === 'browser';
};

const classifyJob = (job: Job<QueueJobPayload>): JobClass => {
  const jobId = String(job.id ?? '');
  if (jobId.startsWith('ai-reclassify-')) {
    return 'ai-reclassify';
  }
  if (jobId.startsWith('ingest-auto-')) {
    return 'ingest-auto';
  }
  if (jobId.startsWith('manual-first-run-')) {
    return 'manual-first-run';
  }
  if (isLegacyBackgroundBrowserJob(job)) {
    return 'legacy-background-browser';
  }
  return 'other';
};

const parseArgs = (): Options => {
  const options: Options = {
    action: 'stats',
    apply: false,
    queueName: QUEUE_NAMES.browser,
    states: [...DEFAULT_STATES],
    prefixes: ['all'],
    limit: null,
    pageSize: 500,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }

    if (arg === '--dry-run') {
      options.apply = false;
      continue;
    }

    if (arg.startsWith('--action=')) {
      const value = (arg.split('=')[1] ?? '').trim();
      if (value === 'stats' || value === 'clear') {
        options.action = value;
      }
      continue;
    }

    if (arg.startsWith('--queue=')) {
      const value = (arg.split('=')[1] ?? '').trim();
      if (value === QUEUE_NAMES.browser || value === QUEUE_NAMES.browserRealtime) {
        options.queueName = value;
      }
      continue;
    }

    if (arg.startsWith('--states=')) {
      const values = (arg.split('=')[1] ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value): value is QueueState => DEFAULT_STATES.includes(value as QueueState));
      if (values.length > 0) {
        options.states = values;
      }
      continue;
    }

    if (arg.startsWith('--prefixes=')) {
      const values = (arg.split('=')[1] ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value): value is JobClass | 'all' => (
          [
            'all',
            'ai-reclassify',
            'ingest-auto',
            'manual-first-run',
            'legacy-background-browser',
            'other',
          ].includes(value)
        ));
      if (values.length > 0) {
        options.prefixes = values;
      }
      continue;
    }

    if (arg.startsWith('--page-size=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) {
        options.pageSize = value;
      }
      continue;
    }

    if (arg.startsWith('--limit=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value >= 0) {
        options.limit = value;
      }
    }
  }

  return options;
};

const prefixMatches = (prefixes: Array<JobClass | 'all'>, prefix: JobClass): boolean => {
  if (prefix === 'legacy-background-browser') {
    return prefixes.includes(prefix);
  }
  return prefixes.includes('all') || prefixes.includes(prefix);
};

const isClearableBackgroundJob = (job: Job<QueueJobPayload>, jobClass: JobClass): boolean => {
  if (!CLEARABLE_CLASSES.has(jobClass)) {
    return false;
  }

  if (jobClass === 'legacy-background-browser') {
    return isLegacyBackgroundBrowserJob(job);
  }

  return job.data?.source === 'system' && job.data?.dispatchLane === 'background';
};

const scanStateJobs = async (
  queue: Queue<QueueJobPayload>,
  state: QueueState,
  pageSize: number,
  onJobs: (jobs: Array<Job<QueueJobPayload>>) => Promise<void>,
): Promise<void> => {
  let start = 0;

  while (true) {
    const jobs = await queue.getJobs([state], start, start + pageSize - 1, true);
    if (jobs.length === 0) {
      return;
    }

    await onJobs(jobs);
    if (jobs.length < pageSize) {
      return;
    }
    start += jobs.length;
  }
};

const main = async () => {
  const options = parseArgs();
  const env = loadEnv();

  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL is required');
  }
  if (options.action === 'clear' && options.queueName === QUEUE_NAMES.browserRealtime) {
    throw new Error('Refusing to clear browser_realtime; this tool only clears rebuildable background browser jobs');
  }
  if (
    options.action === 'clear'
    && options.apply
    && options.prefixes.includes('legacy-background-browser')
    && options.limit == null
  ) {
    throw new Error('Refusing to apply legacy-background-browser cleanup without an explicit --limit');
  }

  const queue = new Queue<QueueJobPayload>(
    buildBullMqQueueName(env.QUEUE_NAME, options.queueName),
    { connection: parseRedisUrl(env.REDIS_URL, env.REDIS_PASSWORD) },
  );

  try {
    const summary: Record<QueueState, Record<JobClass, number>> = {
      wait: {
        'ai-reclassify': 0,
        'ingest-auto': 0,
        'manual-first-run': 0,
        'legacy-background-browser': 0,
        other: 0,
      },
      prioritized: {
        'ai-reclassify': 0,
        'ingest-auto': 0,
        'manual-first-run': 0,
        'legacy-background-browser': 0,
        other: 0,
      },
      delayed: {
        'ai-reclassify': 0,
        'ingest-auto': 0,
        'manual-first-run': 0,
        'legacy-background-browser': 0,
        other: 0,
      },
    };
    const removableJobIds = new Set<string>();
    let matchedClearable = 0;
    let matchedButProtected = 0;
    let skippedLocked = 0;

    for (const state of options.states) {
      await scanStateJobs(queue, state, options.pageSize, async (jobs) => {
        for (const job of jobs) {
          const jobClass = classifyJob(job);
          summary[state][jobClass] += 1;
          if (options.action === 'clear' && prefixMatches(options.prefixes, jobClass) && job.id != null) {
            if (isClearableBackgroundJob(job, jobClass)) {
              matchedClearable += 1;
              if (options.limit == null || removableJobIds.size < options.limit) {
                removableJobIds.add(String(job.id));
              }
            } else {
              matchedButProtected += 1;
            }
          }
        }
      });
    }

    let removed = 0;
    if (options.action === 'clear' && options.apply) {
      for (const jobId of removableJobIds) {
        const job = await queue.getJob(jobId);
        if (!job) {
          continue;
        }
        try {
          await job.remove();
          removed += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('could not be removed because it is locked')) {
            skippedLocked += 1;
            continue;
          }
          throw error;
        }
      }
    }

    console.log(`queue=${options.queueName} action=${options.action} dry_run=${!options.apply}`);
    for (const state of options.states) {
      const counts = summary[state];
      console.log(
        `${state}: ai-reclassify=${counts['ai-reclassify']} ingest-auto=${counts['ingest-auto']} manual-first-run=${counts['manual-first-run']} legacy-background-browser=${counts['legacy-background-browser']} other=${counts.other}`,
      );
    }
    if (options.action === 'clear') {
      console.log(`limit=${options.limit ?? 'none'}`);
      console.log(`matched_clearable=${matchedClearable}`);
      console.log(`${options.apply ? 'removed' : 'would_remove'}=${options.apply ? removed : removableJobIds.size}`);
      console.log(`skipped_locked=${skippedLocked}`);
      console.log(`matched_but_protected=${matchedButProtected}`);
    }
  } finally {
    await queue.close();
  }
};

main().catch((error) => {
  console.error('Browser queue maintenance failed:', error);
  process.exit(1);
});
