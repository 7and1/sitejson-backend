import { describe, it, expect, vi } from 'vitest';
import { SwrCache } from '../swr-cache.js';

const flush = async () => {
  // allow queued microtasks (background refresh) to settle
  await Promise.resolve();
  await Promise.resolve();
};

describe('SwrCache', () => {
  it('loads on cold miss and serves the cached value while fresh', async () => {
    let now = 1000;
    const loader = vi.fn(async () => 'v1');
    const cache = new SwrCache<string>({ ttlMs: 100, now: () => now });

    expect(await cache.get('k', loader)).toBe('v1');
    now = 1050; // still fresh
    expect(await cache.get('k', loader)).toBe('v1');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent cold misses for the same key', async () => {
    const loader = vi.fn(async () => 'v1');
    const cache = new SwrCache<string>({ ttlMs: 100 });

    const [a, b, c] = await Promise.all([
      cache.get('k', loader),
      cache.get('k', loader),
      cache.get('k', loader),
    ]);

    expect([a, b, c]).toEqual(['v1', 'v1', 'v1']);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('serves stale immediately and refreshes in the background after TTL', async () => {
    let now = 1000;
    let value = 'v1';
    const loader = vi.fn(async () => value);
    const cache = new SwrCache<string>({ ttlMs: 100, now: () => now });

    expect(await cache.get('k', loader)).toBe('v1');

    now = 2000; // stale
    value = 'v2';
    // stale read returns old value immediately, triggers background refresh
    expect(await cache.get('k', loader)).toBe('v1');
    await flush();

    now = 2050; // refreshed value is now fresh
    expect(await cache.get('k', loader)).toBe('v2');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('keeps the stale value if a background refresh fails', async () => {
    let now = 1000;
    let mode: 'ok' | 'fail' = 'ok';
    const loader = vi.fn(async () => {
      if (mode === 'fail') throw new Error('boom');
      return 'v1';
    });
    const cache = new SwrCache<string>({ ttlMs: 100, now: () => now });

    expect(await cache.get('k', loader)).toBe('v1');
    now = 2000;
    mode = 'fail';
    expect(await cache.get('k', loader)).toBe('v1'); // stale served
    await flush();
    expect(await cache.get('k', loader)).toBe('v1'); // still stale, no throw
  });

  it('evicts the oldest entry past maxEntries', async () => {
    const cache = new SwrCache<string>({ ttlMs: 10_000, maxEntries: 2 });
    await cache.get('a', async () => 'a');
    await cache.get('b', async () => 'b');
    await cache.get('c', async () => 'c'); // evicts 'a'

    const loaderA = vi.fn(async () => 'a2');
    expect(await cache.get('a', loaderA)).toBe('a2');
    expect(loaderA).toHaveBeenCalledTimes(1); // 'a' was evicted -> reloaded
  });
});

describe('SwrCache with persistence', () => {
  const makePersist = () => {
    const store = new Map<string, { value: unknown; storedAt: number }>();
    return {
      store,
      adapter: {
        load: vi.fn(async (key: string) => store.get(key) ?? null),
        save: vi.fn(async (key: string, value: unknown, storedAt: number) => {
          store.set(key, { value, storedAt });
        }),
      },
    };
  };

  it('persists loaded values', async () => {
    const { store, adapter } = makePersist();
    let now = 1000;
    const cache = new SwrCache<string>({ ttlMs: 100, now: () => now, persist: adapter as never });

    expect(await cache.get('k', async () => 'v1')).toBe('v1');
    await Promise.resolve();
    expect(store.get('k')).toEqual({ value: 'v1', storedAt: 1000 });
  });

  it('serves warm from persistence after a restart without calling the loader', async () => {
    const { adapter } = makePersist();
    let now = 1000;
    const cache1 = new SwrCache<string>({ ttlMs: 100_000, now: () => now, persist: adapter as never });
    await cache1.get('k', async () => 'v1');
    await Promise.resolve();

    // simulate process restart: brand-new in-process cache, same persistence
    now = 1050; // still within ttl
    const loader = vi.fn(async () => 'v2');
    const cache2 = new SwrCache<string>({ ttlMs: 100_000, now: () => now, persist: adapter as never });
    expect(await cache2.get('k', loader)).toBe('v1'); // warm, no loader
    expect(loader).not.toHaveBeenCalled();
  });

  it('serves stale persisted value and refreshes in the background', async () => {
    const { adapter } = makePersist();
    let now = 1000;
    const cache1 = new SwrCache<string>({ ttlMs: 100, now: () => now, persist: adapter as never });
    await cache1.get('k', async () => 'v1');
    await Promise.resolve();

    now = 5000; // persisted value is now stale
    const loader = vi.fn(async () => 'v2');
    const cache2 = new SwrCache<string>({ ttlMs: 100, now: () => now, persist: adapter as never });
    expect(await cache2.get('k', loader)).toBe('v1'); // stale persisted value served
    await Promise.resolve();
    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1); // background refresh ran
  });
});
