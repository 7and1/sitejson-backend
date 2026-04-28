import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublisherProvider } from '../publisher.provider.js';

describe('PublisherProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses ads.txt systems', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('google.com, pub-123, DIRECT\nappnexus.com, 9876, RESELLER', {
        status: 200,
      }),
    );

    const provider = new PublisherProvider({ timeoutMs: 100, retryAttempts: 0, retryBaseMs: 1 }, 'SiteJSONTest/1.0');
    const result = await provider.run({
      domain: 'example.com',
      url: 'https://example.com',
      traceId: 'trc_pub',
      startedAt: Date.now(),
    });

    expect(result.ok).toBe(true);
    expect(result.data?.hasAdsTxt).toBe(true);
    expect(result.data?.adSystems).toContain('google.com');
    expect(result.data?.adSystems).toContain('appnexus.com');
    expect(result.data?.directCount).toBe(1);
    expect(result.data?.resellerCount).toBe(1);
  });

  it('returns missing ads.txt gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not found', { status: 404 }),
    );

    const provider = new PublisherProvider({ timeoutMs: 100, retryAttempts: 0, retryBaseMs: 1 }, 'SiteJSONTest/1.0');
    const result = await provider.run({
      domain: 'example.com',
      url: 'https://example.com',
      traceId: 'trc_pub_404',
      startedAt: Date.now(),
    });

    expect(result.ok).toBe(true);
    expect(result.data?.hasAdsTxt).toBe(false);
  });

  it('treats empty ads.txt as missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 200 }),
    );

    const provider = new PublisherProvider({ timeoutMs: 100, retryAttempts: 0, retryBaseMs: 1 }, 'SiteJSONTest/1.0');
    const result = await provider.run({
      domain: 'example.com',
      url: 'https://example.com',
      traceId: 'trc_pub_empty',
      startedAt: Date.now(),
    });

    expect(result.ok).toBe(true);
    expect(result.data?.hasAdsTxt).toBe(false);
    expect(result.data?.adSystems).toEqual([]);
  });

  it('keeps only valid domain tokens in adSystems', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        [
          'google.com, pub-123, DIRECT',
          '<script>alert(1)</script>',
          'bad token, 123, DIRECT',
          'ownerDomain=Foo.COM, abc, DIRECT',
        ].join('\n'),
        { status: 200 },
      ),
    );

    const provider = new PublisherProvider({ timeoutMs: 100, retryAttempts: 0, retryBaseMs: 1 }, 'SiteJSONTest/1.0');
    const result = await provider.run({
      domain: 'example.com',
      url: 'https://example.com',
      traceId: 'trc_pub_sanitize',
      startedAt: Date.now(),
    });

    expect(result.ok).toBe(true);
    expect(result.data?.hasAdsTxt).toBe(true);
    expect(result.data?.adSystems).toEqual(['google.com', 'foo.com']);
  });
});
