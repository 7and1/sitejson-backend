import { afterEach, describe, expect, it, vi } from 'vitest';
import { AhrefsDomainRatingProvider } from '../authority.provider.js';

const providerOptions = {
  timeoutMs: 100,
  retryAttempts: 0,
  retryBaseMs: 1,
};

const createContext = () => ({
  domain: 'example.com',
  url: 'https://example.com',
  traceId: 'trc_authority',
  startedAt: Date.now(),
});

describe('AhrefsDomainRatingProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns Ahrefs domain rating data with required attribution', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        domain_rating: {
          domain_rating: 93,
          license: 'http://ahrefs.com/legal/domain-rating-license',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new AhrefsDomainRatingProvider(providerOptions, 'SiteJSONTest/1.0');

    const result = await provider.run(createContext());

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      domainRating: 93,
      source: 'ahrefs',
      licenseUrl: 'http://ahrefs.com/legal/domain-rating-license',
      attribution: 'Domain Rating by Ahrefs',
    });
    expect(result.data?.fetchedAt).toEqual(expect.any(String));
    expect(fetchSpy.mock.calls[0]?.[0]?.toString()).toContain('target=example.com');
  });

  it('maps a rate-limited Ahrefs response to providerHealth-friendly failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'rate limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new AhrefsDomainRatingProvider(providerOptions, 'SiteJSONTest/1.0');

    const result = await provider.run(createContext());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('AHREFS_DR_RATE_LIMITED');
  });

  it('fails closed when Ahrefs response shape is missing the numeric rating', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ domain_rating: { license: 'https://ahrefs.com/legal/domain-rating-license' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new AhrefsDomainRatingProvider(providerOptions, 'SiteJSONTest/1.0');

    const result = await provider.run(createContext());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('AHREFS_DR_INVALID_RESPONSE');
  });
});
