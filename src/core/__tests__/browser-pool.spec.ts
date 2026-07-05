import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
}));

vi.mock('playwright', () => ({
  chromium: {
    launch: mocks.launch,
  },
}));

const { BrowserPool } = await import('../browser-pool.js');

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const createBrowser = (connected: boolean) => ({
  isConnected: vi.fn(() => connected),
  close: vi.fn(async () => undefined),
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
};

describe('BrowserPool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('waits for and closes a replacement browser when pool shutdown wins the release race', async () => {
    const pool = new BrowserPool(1, logger as any);
    const waiterPromise = pool.acquire();
    const launch = deferred<any>();
    const releasedBrowser = createBrowser(false);
    const replacementBrowser = createBrowser(true);

    mocks.launch.mockReturnValueOnce(launch.promise);

    pool.release(releasedBrowser as any);
    const waiterExpectation = expect(waiterPromise).rejects.toThrow('BrowserPool is closed');
    const closePromise = pool.close();
    await Promise.resolve();

    expect(replacementBrowser.close).not.toHaveBeenCalled();
    launch.resolve(replacementBrowser as any);

    await closePromise;
    await waiterExpectation;
    expect(replacementBrowser.close).toHaveBeenCalledTimes(1);
  });
});
