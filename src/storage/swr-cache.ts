/**
 * Optional persistence backend for {@link SwrCache}. Lets cached values survive
 * process restarts (e.g. in Redis), so a redeploy reads warm values instead of
 * re-running the slow loader on every key (which causes a cold-start burst).
 */
export interface SwrPersistence<T> {
  load(key: string): Promise<{ value: T; storedAt: number } | null>;
  save(key: string, value: T, storedAt: number): Promise<void>;
}

export interface SwrCacheOptions<T> {
  /** How long a value is considered fresh, in milliseconds. */
  ttlMs: number;
  /** Maximum number of in-process keys retained; oldest is evicted past this. */
  maxEntries?: number;
  /** Optional cross-restart persistence (e.g. Redis). */
  persist?: SwrPersistence<T>;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Minimal structural subset of an ioredis client used for persistence. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
}

/**
 * Builds a {@link SwrPersistence} backed by a Redis-like client. Values are
 * stored as JSON `{v,t}` (value + storedAt) under `${prefix}:${key}` with a
 * generous Redis TTL so stale-but-usable values survive restarts.
 */
export const createRedisSwrPersistence = <T>(
  redis: RedisLike,
  prefix: string,
  redisTtlSeconds: number,
): SwrPersistence<T> => ({
  async load(key) {
    const raw = await redis.get(`${prefix}:${key}`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { v: T; t: number };
      if (parsed && typeof parsed.t === 'number') {
        return { value: parsed.v, storedAt: parsed.t };
      }
    } catch {
      // corrupt entry — treat as miss
    }
    return null;
  },
  async save(key, value, storedAt) {
    await redis.set(`${prefix}:${key}`, JSON.stringify({ v: value, t: storedAt }), 'EX', redisTtlSeconds);
  },
});

interface SwrEntry<T> {
  value: T;
  freshUntil: number;
  refreshing: boolean;
}

/**
 * Stale-while-revalidate cache with single-flight loading and optional
 * cross-restart persistence.
 *
 * - Fresh in-process hit: returns the cached value.
 * - Stale in-process hit: returns it immediately, refreshes in the background.
 * - Cold miss: checks persistence first (so a restart serves warm values
 *   without running the slow loader); only on a persistence miss is the loader
 *   awaited. Concurrent misses for the same key share one in-flight promise.
 *
 * The loader therefore stays off the request path after the first population
 * (process- or cluster-wide, when persistence is configured), so a cache
 * expiry or a redeploy can never make a request block on (and time out
 * against) the underlying query.
 */
export class SwrCache<T> {
  private readonly store = new Map<string, SwrEntry<T>>();
  private readonly pending = new Map<string, Promise<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly persist?: SwrPersistence<T>;
  private readonly now: () => number;

  constructor(options: SwrCacheOptions<T>) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries ?? 1000;
    this.persist = options.persist;
    this.now = options.now ?? (() => Date.now());
  }

  async get(key: string, loader: () => Promise<T>): Promise<T> {
    const entry = this.store.get(key);
    if (entry) {
      if (this.now() >= entry.freshUntil && !entry.refreshing) {
        entry.refreshing = true;
        this.backgroundRefresh(key, loader);
      }
      return entry.value;
    }

    const inflight = this.pending.get(key);
    if (inflight) return inflight;

    const promise = this.coldLoad(key, loader);
    this.pending.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(key);
    }
  }

  private async coldLoad(key: string, loader: () => Promise<T>): Promise<T> {
    if (this.persist) {
      let hit: { value: T; storedAt: number } | null = null;
      try {
        hit = await this.persist.load(key);
      } catch {
        hit = null;
      }
      if (hit) {
        const freshUntil = hit.storedAt + this.ttlMs;
        const stale = this.now() >= freshUntil;
        this.store.set(key, { value: hit.value, freshUntil, refreshing: stale });
        this.evict(key);
        if (stale) this.backgroundRefresh(key, loader);
        return hit.value;
      }
    }

    const value = await loader();
    this.commit(key, value);
    return value;
  }

  private backgroundRefresh(key: string, loader: () => Promise<T>): void {
    void loader().then(
      (value) => this.commit(key, value),
      () => {
        const entry = this.store.get(key);
        if (entry) entry.refreshing = false;
      },
    );
  }

  private commit(key: string, value: T): void {
    const storedAt = this.now();
    this.store.set(key, { value, freshUntil: storedAt + this.ttlMs, refreshing: false });
    this.evict(key);
    if (this.persist) {
      void this.persist.save(key, value, storedAt).catch(() => {
        // persistence is best-effort; in-process cache still serves
      });
    }
  }

  private evict(key: string): void {
    if (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value as string | undefined;
      if (oldest !== undefined && oldest !== key) {
        this.store.delete(oldest);
      }
    }
  }

  clear(): void {
    this.store.clear();
    this.pending.clear();
  }
}
