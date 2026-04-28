import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeRotationBackoffMs,
  fetchHtmlWithFallbackChain,
  fetchWithProxyRotation,
  parseRetryAfterMs,
} from '../http.js';

describe('fetchWithProxyRotation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to direct fetch when proxy pools are empty', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    const response = await fetchWithProxyRotation('https://example.com', {
      timeoutMs: 100,
      retryBaseMs: 1,
      primaryProxies: [],
      fallbackProxies: [],
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('throws HTTP status when direct fetch fallback is not ok', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('upstream error', { status: 503 }),
    );

    await expect(fetchWithProxyRotation('https://example.com', {
      timeoutMs: 100,
      retryBaseMs: 1,
      primaryProxies: [],
      fallbackProxies: [],
    })).rejects.toThrow('HTTP_503');
  });

  it('tries direct fetch once after all proxies fail', async () => {
    const directFetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    const response = await fetchWithProxyRotation('https://example.com', {
      timeoutMs: 100,
      retryBaseMs: 1,
      primaryProxies: [
        { host: '127.0.0.1', port: 1, username: 'u', password: 'p' },
      ],
      fallbackProxies: [
        { host: '127.0.0.1', port: 2, username: 'u2', password: 'p2' },
      ],
    });

    expect(response.status).toBe(200);
    expect(directFetchSpy).toHaveBeenCalledOnce();
  });
});

describe('retry helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses Retry-After seconds and HTTP-date', () => {
    expect(parseRetryAfterMs('5', 0)).toBe(5000);

    const now = Date.parse('Wed, 21 Oct 2015 07:27:00 GMT');
    expect(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', now)).toBe(60000);
  });

  it('returns null for invalid Retry-After values', () => {
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs('not-a-date')).toBeNull();
  });

  it('computes capped exponential backoff with retry-after override', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(computeRotationBackoffMs({
      retryBaseMs: 500,
      attempt: 2,
      isFallback: false,
    })).toBe(1000);

    expect(computeRotationBackoffMs({
      retryBaseMs: 500,
      attempt: 2,
      isFallback: true,
    })).toBe(2000);

    expect(computeRotationBackoffMs({
      retryBaseMs: 500,
      attempt: 1,
      isFallback: false,
      retryAfterMs: 4000,
    })).toBe(4000);

    expect(computeRotationBackoffMs({
      retryBaseMs: 500,
      attempt: 1,
      isFallback: false,
      retryAfterMs: 120000,
    })).toBe(60000);
  });
});

describe('fetchHtmlWithFallbackChain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns direct html when available', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html><body>ok</body></html>', { status: 200 }),
    );

    const result = await fetchHtmlWithFallbackChain('https://example.com', {
      timeoutMs: 100,
      retryAttempts: 0,
      retryBaseMs: 1,
      userAgent: 'Test/1.0',
    });

    expect(result?.source).toBe('direct');
    expect(result?.trace[0]?.source).toBe('direct');
    expect(result?.trace[0]?.ok).toBe(true);
  });
});
