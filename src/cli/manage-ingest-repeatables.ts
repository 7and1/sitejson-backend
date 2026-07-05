import { Queue } from 'bullmq';
import { loadEnv } from '../config/env.js';
import { buildBullMqQueueName, buildRepeatableJobId, parseRedisUrl } from '../queue/bullmq.js';
import { QUEUE_NAMES } from '../queue/names.js';
import type { QueueJobPayload } from '../queue/interfaces.js';

type Purpose = Extract<QueueJobPayload['purpose'], 'ingest-auto-feed' | 'ai-retry-feed'>;
const VALID_PURPOSES: Purpose[] = ['ingest-auto-feed', 'ai-retry-feed'];

interface Options {
  apply: boolean;
  removePurposes: Purpose[];
}

const parseArgs = (): Options => {
  const options: Options = {
    apply: false,
    removePurposes: [],
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

    if (arg === '--remove-disabled') {
      const env = loadEnv();
      if (!env.INGEST_AUTO_FEED_ENABLED) {
        options.removePurposes.push('ingest-auto-feed');
      }
      if (!env.AI_RETRY_FEED_ENABLED) {
        options.removePurposes.push('ai-retry-feed');
      }
      continue;
    }

    if (arg.startsWith('--remove=')) {
      const values = (arg.split('=')[1] ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value): value is Purpose => VALID_PURPOSES.includes(value as Purpose));
      options.removePurposes.push(...values);
    }
  }

  options.removePurposes = Array.from(new Set(options.removePurposes));
  return options;
};

const collectMatchingRepeatableKeys = async (
  queue: Queue<QueueJobPayload>,
  purposes: Purpose[],
): Promise<Set<string>> => {
  const keys = new Set<string>();
  if (purposes.length === 0) {
    return keys;
  }

  const repeatables = await queue.getRepeatableJobs(0, -1, true);

  for (const purpose of purposes) {
    const repeatableId = buildRepeatableJobId(QUEUE_NAMES.ingest, purpose);
    for (const repeatable of repeatables) {
      const matches =
        repeatable.name === repeatableId
        || repeatable.key.includes(repeatableId)
        || repeatable.key.includes(purpose);

      if (!matches) {
        continue;
      }

      keys.add(repeatable.key);
    }
  }

  return keys;
};

const removeRepeatableKeys = async (
  queue: Queue<QueueJobPayload>,
  keys: Set<string>,
): Promise<number> => {
  let removed = 0;
  for (const key of keys) {
    await queue.removeRepeatableByKey(key);
    removed += 1;
  }
  return removed;
};

const main = async () => {
  const options = parseArgs();
  const env = loadEnv();

  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL is required');
  }

  const queue = new Queue<QueueJobPayload>(
    buildBullMqQueueName(env.QUEUE_NAME, QUEUE_NAMES.ingest),
    { connection: parseRedisUrl(env.REDIS_URL, env.REDIS_PASSWORD) },
  );

  try {
    const before = await queue.getRepeatableJobs(0, -1, true);
    console.log(`queue=${QUEUE_NAMES.ingest} dry_run=${!options.apply}`);
    console.log(`repeatable_count=${before.length}`);

    if (options.removePurposes.length > 0) {
      console.log(`remove_purposes=${options.removePurposes.join(',')}`);
      const matchingKeys = await collectMatchingRepeatableKeys(queue, options.removePurposes);
      if (!options.apply) {
        console.log(`would_remove=${matchingKeys.size}`);
        return;
      }

      const removed = await removeRepeatableKeys(queue, matchingKeys);
      console.log(`removed=${removed}`);
      const after = await queue.getRepeatableJobs(0, -1, true);
      console.log(`remaining_repeatable_count=${after.length}`);
    }
  } finally {
    await queue.close();
  }
};

main().catch((error) => {
  console.error('Repeatable maintenance failed:', error);
  process.exit(1);
});
