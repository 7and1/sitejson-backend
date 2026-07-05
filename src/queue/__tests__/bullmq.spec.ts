import { describe, expect, it, vi } from 'vitest';
import { QueueCapacityError } from '../errors.js';
import { BullMqJobQueue, getJobOptionsForQueue, getWorkerOptionsForQueue, parseRedisUrl } from '../bullmq.js';
import { QUEUE_NAMES } from '../names.js';

const queueAddSpy = vi.hoisted(() => vi.fn());
const queueAddBulkSpy = vi.hoisted(() => vi.fn());

vi.mock('bullmq', () => ({
  Queue: class {
    add = queueAddSpy;
    addBulk = queueAddBulkSpy;
    close = vi.fn(async () => {});
    getJobCounts = vi.fn(async () => ({}));
  },
  Worker: class {},
}), { virtual: true });

describe('parseRedisUrl', () => {
  it('uses URL credentials when provided', () => {
    expect(parseRedisUrl('redis://default:url-pass@redis.example:6380')).toEqual({
      host: 'redis.example',
      port: 6380,
      username: 'default',
      password: 'url-pass',
      tls: undefined,
    });
  });

  it('uses an explicit password override when the URL has no password', () => {
    expect(parseRedisUrl('redis://sitejson-redis:6379', 'runtime-pass')).toEqual({
      host: 'sitejson-redis',
      port: 6379,
      username: undefined,
      password: 'runtime-pass',
      tls: undefined,
    });
  });

  it('enables tls for rediss URLs', () => {
    expect(parseRedisUrl('rediss://redis.example')).toEqual({
      host: 'redis.example',
      port: 6379,
      username: undefined,
      password: undefined,
      tls: {},
    });
  });
});

describe('getWorkerOptionsForQueue', () => {
  it('keeps browser realtime locks short enough for fast crash recovery', () => {
    const options = getWorkerOptionsForQueue(QUEUE_NAMES.browserRealtime);

    expect(options.lockDuration).toBe(300_000);
    expect(options.lockRenewTime).toBe(15_000);
    expect(options.stalledInterval).toBeLessThanOrEqual(60_000);
    expect(options.maxStalledCount).toBe(2);
  });

  it('keeps background browser locks long for slow domains', () => {
    const options = getWorkerOptionsForQueue(QUEUE_NAMES.browser);

    expect(options.lockDuration).toBe(1_200_000);
    expect(options.stalledInterval).toBe(120_000);
    expect(options.maxStalledCount).toBe(2);
  });
});

describe('getJobOptionsForQueue', () => {
  it('keeps browser queue failed-job retention to one day instead of a week', () => {
    const options = getJobOptionsForQueue(QUEUE_NAMES.browser);

    expect(options.removeOnFail).toEqual({ age: 86_400, count: 200 });
  });

  it('keeps cheaper async queue failures on the shorter shared retention window', () => {
    const options = getJobOptionsForQueue(QUEUE_NAMES.async);

    expect(options.removeOnFail).toEqual({ age: 43_200, count: 200 });
  });
});

describe('BullMqJobQueue enqueue error wrapping', () => {
  it('wraps Redis OOM add failures as QueueCapacityError', async () => {
    queueAddSpy.mockRejectedValueOnce(new Error("OOM command not allowed when used memory > 'maxmemory'."));
    const queue = new BullMqJobQueue({ host: 'redis', port: 6379 }, 'sitejson', {}, 1);

    await expect(queue.enqueue({
      jobId: 'job-1',
      domain: 'example.com',
      traceId: 'trc-1',
      phase: QUEUE_NAMES.ingest,
    }, QUEUE_NAMES.ingest)).rejects.toBeInstanceOf(QueueCapacityError);
  });

  it('wraps Redis OOM bulk-add failures as QueueCapacityError', async () => {
    queueAddBulkSpy.mockRejectedValueOnce(new Error("OOM command not allowed when used memory > 'maxmemory'."));
    const queue = new BullMqJobQueue({ host: 'redis', port: 6379 }, 'sitejson', {}, 1);

    await expect(queue.enqueueBulk([{
      jobId: 'job-1',
      domain: 'example.com',
      traceId: 'trc-1',
      phase: QUEUE_NAMES.ingest,
    }], QUEUE_NAMES.ingest)).rejects.toBeInstanceOf(QueueCapacityError);
  });
});
