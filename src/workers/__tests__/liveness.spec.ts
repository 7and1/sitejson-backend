import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STUCK_JOB_AFTER_MS,
  HEARTBEAT_INTERVAL_MS,
  findStuckJob,
  startHeartbeat,
  stuckJobAfterMs,
} from '../liveness.js';
import { QUEUE_NAMES } from '../../queue/names.js';

const MIN = 60_000;
const now = 10_000 * MIN;

const createLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  debug: vi.fn(),
});

describe('findStuckJob', () => {
  it('returns null when every active job is within its budget', () => {
    expect(findStuckJob([], now)).toBeNull();
    expect(findStuckJob([
      { queueName: QUEUE_NAMES.browser, jobId: 'a', startedAt: now - 5 * MIN },
      { queueName: QUEUE_NAMES.async, jobId: 'b', startedAt: now - 29 * MIN },
    ], now)).toBeNull();
  });

  it('returns the oldest job that outlived its budget', () => {
    const stuck = findStuckJob([
      { queueName: QUEUE_NAMES.browser, jobId: 'fresh', startedAt: now - 1 * MIN },
      { queueName: QUEUE_NAMES.browser, jobId: 'stuck-31m', startedAt: now - 31 * MIN },
      { queueName: QUEUE_NAMES.browserRealtime, jobId: 'stuck-10h', startedAt: now - 600 * MIN },
    ], now);

    expect(stuck).toEqual({
      queueName: QUEUE_NAMES.browserRealtime,
      jobId: 'stuck-10h',
      startedAt: now - 600 * MIN,
      ageMs: 600 * MIN,
    });
  });

  it('gives radar bulk imports a longer budget than browser jobs', () => {
    expect(stuckJobAfterMs(QUEUE_NAMES.browser)).toBe(DEFAULT_STUCK_JOB_AFTER_MS);
    expect(stuckJobAfterMs(QUEUE_NAMES.radar)).toBeGreaterThan(DEFAULT_STUCK_JOB_AFTER_MS);
    expect(findStuckJob([{ queueName: QUEUE_NAMES.radar, jobId: 'r', startedAt: now - 60 * MIN }], now)).toBeNull();
    expect(findStuckJob([{ queueName: QUEUE_NAMES.browser, jobId: 'b', startedAt: now - 60 * MIN }], now)?.jobId).toBe('b');
  });
});

describe('startHeartbeat', () => {
  let dir: string | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('writes the heartbeat file while jobs make progress', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sitejson-heartbeat-'));
    const file = join(dir, 'heartbeat');
    const onStuck = vi.fn();

    const timer = startHeartbeat(file, createLogger() as any, () => [
      { queueName: QUEUE_NAMES.browser, jobId: 'a', startedAt: Date.now() - MIN },
    ], onStuck);
    try {
      await vi.waitFor(() => expect(existsSync(file)).toBe(true));
      expect(onStuck).not.toHaveBeenCalled();
    } finally {
      clearInterval(timer);
    }
  });

  it('stops the heartbeat and requests a restart exactly once when a job is wedged', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    dir = await mkdtemp(join(tmpdir(), 'sitejson-heartbeat-'));
    const file = join(dir, 'heartbeat');
    const logger = createLogger();
    const onStuck = vi.fn();
    const wedged = { queueName: QUEUE_NAMES.browser, jobId: 'job-10h', startedAt: Date.now() - 600 * MIN };

    const timer = startHeartbeat(file, logger as any, () => [wedged], onStuck);
    try {
      vi.advanceTimersByTime(3 * HEARTBEAT_INTERVAL_MS);
      await new Promise((resolve) => setImmediate(resolve));

      expect(onStuck).toHaveBeenCalledTimes(1);
      expect(onStuck).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-10h', queueName: QUEUE_NAMES.browser }));
      expect(logger.fatal).toHaveBeenCalledTimes(1);
      expect(logger.fatal).toHaveBeenCalledWith(expect.objectContaining({ event: 'worker_stuck_job', job_id: 'job-10h' }));
      expect(existsSync(file)).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });
});
