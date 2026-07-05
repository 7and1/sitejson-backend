import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { promises as dns } from 'node:dns';
import * as httpModule from '../../providers/http.js';
import { Orchestrator } from '../orchestrator.js';
import { createLogger } from '../../observability/logger.js';
import { MetaProvider } from '../../providers/meta.provider.js';
import { SeoProvider } from '../../providers/seo.provider.js';

const providerOptions = {
  timeoutMs: 100,
  retryAttempts: 0,
  retryBaseMs: 1,
};

const runtimeOptions = {
  timeoutMs: 100,
  providerQuickTimeoutMs: 25,
  aiTimeoutMs: 250,
  retryAttempts: 0,
  retryBaseMs: 1,
  userAgent: 'SiteJSONTest/1.0',
  aiEnableAutoTrigger: true,
  aiAutoTriggerRankLimit: 1000000,
  browserEnabled: true,
  browserTimeoutMs: 100,
  browserHighValueTimeoutMs: 150,
  browserNetworkIdleTimeoutMs: 25,
  browserViewport: { width: 1200, height: 700 },
  proxyGridBaseUrl: 'http://localhost:9000',
  proxyGridSecret: 'grid-secret',
  soaxApiUrl: 'http://localhost:9001',
  soaxApiSecret: 'soax-secret',
  soaxCountry: 'us',
  soaxProxyType: 1,
};

describe('Orchestrator resilience', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to HTML chain when browser lane crashes', async () => {
    vi.spyOn(dns, 'resolve4').mockResolvedValue(['93.184.216.34']);
    vi.spyOn(dns, 'resolve6').mockResolvedValue([]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 200 }),
    );
    vi.spyOn(chromium, 'launch').mockRejectedValue(new Error('CRITICAL_BROWSER_CRASH'));
    vi.spyOn(httpModule, 'fetchDirectWithSafeRedirects').mockResolvedValue(
      new Response('', { status: 200 }),
    );

    vi.spyOn(httpModule, 'fetchHtmlWithFallbackChain').mockResolvedValue({
      html: '<html><head><title>Fallback Title</title><meta name="description" content="fallback"></head><body><h1>Fallback H1</h1></body></html>',
      source: 'proxy_grid',
      trace: [{
        lane: 'browser',
        source: 'proxy_grid',
        ok: true,
        latencyMs: 8,
      }],
    });

    const orchestrator = new Orchestrator(
      [
        new MetaProvider(providerOptions, 'SiteJSONTest/1.0'),
        new SeoProvider(providerOptions, 'SiteJSONTest/1.0'),
      ],
      createLogger('error'),
      runtimeOptions,
    );

    const report = await orchestrator.analyze('crash-test.com', 'trc_crash_test');

    expect(report.meta?.title).toBe('Fallback Title');
    expect(report._meta?.html?.source).toBe('proxy_grid');
    expect(report._meta?.debug?.fallback_path?.browser).toBe('proxy_grid');
    expect(report.visual).toBeUndefined();
    expect((report as unknown as Record<string, unknown>).score).toBeUndefined();
  });
});
