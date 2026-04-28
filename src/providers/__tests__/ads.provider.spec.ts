import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdsProvider } from '../ads.provider.js';

describe('AdsProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses advertiser ids from response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"1":[{"1":"AR12256352871842316289","12":"Meta Platforms, Inc."}],"2":1}', {
        status: 200,
      }),
    );

    const provider = new AdsProvider({ timeoutMs: 100, retryAttempts: 0, retryBaseMs: 1 }, 'SiteJSONTest/1.0');
    const result = await provider.run({
      domain: 'facebook.com',
      url: 'https://facebook.com',
      traceId: 'trc_ads',
      startedAt: Date.now(),
    });

    expect(result.ok).toBe(true);
    expect(result.data?.isAdvertiser).toBe(true);
    expect(result.data?.advertiserIds).toContain('AR12256352871842316289');
  });
});
