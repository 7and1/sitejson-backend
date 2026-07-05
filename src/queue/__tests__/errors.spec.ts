import { describe, expect, it } from 'vitest';
import { QueueCapacityError, asQueueCapacityError, isRedisQueueCapacityErrorMessage } from '../errors.js';

describe('queue capacity errors', () => {
  it('detects Redis noeviction OOM messages', () => {
    expect(
      isRedisQueueCapacityErrorMessage("OOM command not allowed when used memory > 'maxmemory'."),
    ).toBe(true);
  });

  it('wraps Redis OOM failures into QueueCapacityError', () => {
    const wrapped = asQueueCapacityError(new Error("OOM command not allowed when used memory > 'maxmemory'."));

    expect(wrapped).toBeInstanceOf(QueueCapacityError);
    expect(wrapped?.message).toContain("OOM command not allowed");
  });

  it('ignores unrelated queue failures', () => {
    expect(asQueueCapacityError(new Error('ECONNRESET'))).toBeNull();
  });
});
