import { promises as dns } from 'node:dns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Orchestrator, buildPinnedHostResolverRules, shouldAllowBrowserRequestUrl, resolveProviderDeadlineMs } from '../orchestrator.js';
import { createLogger } from '../../observability/logger.js';
import {
  AdsProvider,
  AiProvider,
  DnsProvider,
  FilesProvider,
  MetaProvider,
  PublisherProvider,
  SeoProvider,
  VisualProvider,
} from '../../providers/index.js';
import { ScreenshotStorage } from '../../lib/screenshot-storage.js';
import type { Provider } from '../../providers/base.js';

const mockChromiumLaunch = vi.hoisted(() => vi.fn());

vi.mock('node:dns', () => ({
  promises: {
    resolve4: vi.fn(async () => ['93.184.216.34']),
    resolve6: vi.fn(async () => []),
  },
}));

vi.mock('playwright', () => ({
  chromium: {
    launch: mockChromiumLaunch,
  },
}));

const mockPublicDns = () => {
  vi.mocked(dns.resolve4).mockResolvedValue(['93.184.216.34']);
  vi.mocked(dns.resolve6).mockResolvedValue([]);
};

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
  browserEnabled: false,
  browserTimeoutMs: 100,
  browserHighValueTimeoutMs: 150,
  browserNetworkIdleTimeoutMs: 25,
  browserViewport: { width: 1200, height: 700 },
  proxyGridBaseUrl: 'http://localhost:9000',
  proxyGridSecret: 'x',
  soaxApiUrl: 'http://localhost:9001',
  soaxApiSecret: 'y',
  soaxCountry: 'us',
  soaxProxyType: 1,
};

const createNoopScreenshotStorage = () => ({
  save: vi.fn(async () => ({
    storage: 'local' as const,
    screenshotPath: '/tmp/example.png',
  })),
}) as unknown as ScreenshotStorage;

beforeEach(() => {
  vi.clearAllMocks();
  mockChromiumLaunch.mockReset();
  mockPublicDns();
});

describe('resolveProviderDeadlineMs', () => {
  it('uses the quick timeout for cheap providers and preserves ai timeout separately', () => {
    expect(resolveProviderDeadlineMs('meta.provider', runtimeOptions)).toBe(25);
    expect(resolveProviderDeadlineMs('seo.provider', runtimeOptions)).toBe(25);
    expect(resolveProviderDeadlineMs('traffic.provider', runtimeOptions)).toBe(100);
    expect(resolveProviderDeadlineMs('ai.provider', runtimeOptions)).toBe(250);
  });
});

describe('shouldAllowBrowserRequestUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockPublicDns();
  });

  it('allows public http requests and caches host safety verdicts', async () => {
    const cache = new Map<string, Promise<boolean>>();

    await expect(shouldAllowBrowserRequestUrl('https://cdn.example.com/app.js', cache)).resolves.toBe(true);
    await expect(shouldAllowBrowserRequestUrl('https://cdn.example.com/style.css', cache)).resolves.toBe(true);

    expect(dns.resolve4).toHaveBeenCalledTimes(1);
    expect(dns.resolve6).toHaveBeenCalledTimes(1);
  });

  it('allows browser-local non-network URLs', async () => {
    const cache = new Map<string, Promise<boolean>>();

    await expect(shouldAllowBrowserRequestUrl('data:image/png;base64,AA==', cache)).resolves.toBe(true);
    await expect(shouldAllowBrowserRequestUrl('about:blank', cache)).resolves.toBe(true);

    expect(dns.resolve4).not.toHaveBeenCalled();
    expect(dns.resolve6).not.toHaveBeenCalled();
  });

  it('blocks unsafe schemes, credentials, and private DNS results', async () => {
    const cache = new Map<string, Promise<boolean>>();
    vi.mocked(dns.resolve4).mockResolvedValueOnce(['10.0.0.5']);
    vi.mocked(dns.resolve6).mockResolvedValueOnce([]);

    await expect(shouldAllowBrowserRequestUrl('file:///etc/passwd', cache)).resolves.toBe(false);
    await expect(shouldAllowBrowserRequestUrl('https://user:pass@example.com/app.js', cache)).resolves.toBe(false);
    await expect(shouldAllowBrowserRequestUrl('https://internal.example/app.js', cache)).resolves.toBe(false);
  });
});

describe('Orchestrator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockPublicDns();
  });

  it('merges provider outputs into report with extended providers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        '<html><head><title>Example</title><meta name="description" content="Desc"></head><body><h1>H</h1><a href="mailto:hi@example.com">x</a></body></html>',
        {
          status: 200,
          headers: { 'content-type': 'text/html' },
        },
      ),
    );

    const customProviders: Provider[] = [
      new VisualProvider(createNoopScreenshotStorage(), { info: () => {}, warn: () => {} } as any),
      new MetaProvider(providerOptions, 'SiteJSONTest/1.0'),
      new SeoProvider(providerOptions, 'SiteJSONTest/1.0'),
      new DnsProvider(providerOptions),
      new AdsProvider(providerOptions, 'SiteJSONTest/1.0'),
      new PublisherProvider(providerOptions, 'SiteJSONTest/1.0'),
      new FilesProvider(providerOptions, 'SiteJSONTest/1.0'),
      {
        name: 'authority.provider',
        run: async () => ({
          provider: 'authority.provider',
          ok: true,
          latencyMs: 1,
          data: {
            domainRating: 93,
            source: 'ahrefs',
            licenseUrl: 'https://ahrefs.com/legal/domain-rating-license',
            attribution: 'Domain Rating by Ahrefs',
            fetchedAt: '2026-06-14T00:00:00.000Z',
          },
        }),
      },
      {
        name: 'history.provider',
        run: async () => ({
          provider: 'history.provider',
          ok: true,
          latencyMs: 1,
          data: {
            status: 'ready',
            source: 'archiverisk',
            cacheHit: true,
            archiveScore: 81,
            archiveScoreBand: 'clean',
            archiveVerdict: 'likely_clean',
            label: 'Real business',
            language: 'English',
            sensitiveWords: [],
            riskFlags: ['real_business'],
            firstCaptureYear: 2012,
            lastCaptureYear: 2026,
            historyAgeMonths: 120,
            longestStreakYears: 10,
            distinctBuildingYears: 9,
            recentYearsBuilt: 5,
            capturesCount: 14,
            yearHistogram: [{ year: 2026, count: 2 }],
            titles: [{
              year: 2026,
              timestamp: '20260101120000',
              title: 'Example',
              archiveUrl: 'https://web.archive.org/web/20260101120000/https://example.com',
            }],
            computedAt: '2026-07-06T00:00:00.000Z',
          },
        }),
      },
      {
        name: 'radar.provider',
        run: async () => ({
          provider: 'radar.provider',
          ok: true,
          latencyMs: 1,
          data: {
            globalRank: 5000,
            rankBucket: 'Top 10k',
            categories: ['Technology'],
            sourceTimestamp: new Date().toISOString(),
            queued: false,
          },
        }),
      },
      {
        name: 'traffic.provider',
        run: async () => ({
          provider: 'traffic.provider',
          ok: true,
          latencyMs: 1,
          data: {
            monthlyVisits: 100000,
            globalRank: 50000,
            countryRank: 1000,
            bounceRate: 10,
            avgVisitDuration: 100,
            pagesPerVisit: 2,
            dataYear: '2026',
            dataMonth: '02',
            trafficSources: null,
            topKeywords: [],
            topRegions: [],
            domainAgeYears: 5,
            cachedAt: null,
            whois: null,
          },
        }),
      },
      {
        name: 'whois.provider',
        run: async () => ({
          provider: 'whois.provider',
          ok: true,
          latencyMs: 1,
          data: {
            domainAgeYears: 5.4,
            whois: {
              registrar: 'Example Registrar',
              createdAt: '2020-01-01T00:00:00Z',
              expiresAt: null,
              updatedAt: null,
              nameservers: [],
              status: [],
            },
          },
        }),
      },
      {
        name: 'ai.provider',
        run: async () => ({
          provider: 'ai.provider',
          ok: true,
          latencyMs: 1,
          data: {
            iabCategory: 'Technology & Computing',
            iabSubCategory: 'Software',
            confidence: 0.92,
            tags: ['saas', 'cloud'],
            business: {
              summary: 'test',
              model: 'subscription',
              targetAudience: 'developers',
            },
            risk: {
              sentiment: 'Professional',
              score: 12,
              isSpam: false,
            },
          },
        }),
      },
    ];

    const orchestrator = new Orchestrator(
      customProviders,
      createLogger('error'),
      runtimeOptions,
    );

    const report = await orchestrator.analyze('example.com', 'trc_test');
    expect(report.domain).toBe('example.com');
    expect(report.meta?.title).toBe('Example');
    expect(report.seo?.internalLinks).toBe(0);
    expect(report.taxonomy?.iabCategory).toBe('Technology & Computing');
    expect(report.authority?.domainRating).toBe(93);
    expect(report.authority?.attribution).toBe('Domain Rating by Ahrefs');
    expect(report.history?.archiveVerdict).toBe('likely_clean');
    expect(report.history?.titles[0]?.title).toBe('Example');
    expect(report.radar?.globalRank).toBe(5000);
    expect(report.trafficData?.whois?.registrar).toBe('Example Registrar');
    expect(report.trafficData?.domainAgeYears).toBe(5.4);
    expect(report.providerHealth?.some((item) => item.provider === 'ai.provider')).toBe(true);
    expect((report as unknown as Record<string, unknown>).score).toBeUndefined();
  });

  it('skips ai.provider when auto trigger is disabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        '<html><head><title>Trusted Company</title><meta name="description" content="Desc"></head><body><h1>H</h1></body></html>',
        {
          status: 200,
          headers: { 'content-type': 'text/html' },
        },
      ),
    );

    const orchestrator = new Orchestrator(
      [
        new MetaProvider(providerOptions, 'SiteJSONTest/1.0'),
        new SeoProvider(providerOptions, 'SiteJSONTest/1.0'),
        {
          name: 'traffic.provider',
          run: async () => ({
            provider: 'traffic.provider',
            ok: true,
            latencyMs: 1,
            data: {
              monthlyVisits: 100000,
              globalRank: 500,
              countryRank: 10,
              bounceRate: 10,
              avgVisitDuration: 100,
              pagesPerVisit: 2,
              dataYear: '2026',
              dataMonth: '02',
              trafficSources: null,
              topKeywords: [],
              topRegions: [],
              domainAgeYears: 5,
              cachedAt: null,
              whois: null,
            },
          }),
        },
        {
          name: 'ai.provider',
          run: async () => ({
            provider: 'ai.provider',
            ok: true,
            latencyMs: 1,
            data: {
              classification: { category: 'x', subCategory: 'y', tags: [] },
              business: { summary: '', model: '', targetAudience: '' },
              risk: { sentiment: 'Professional', score: 1, isSpam: false },
            },
          }),
        },
      ],
      createLogger('error'),
      {
        ...runtimeOptions,
        aiEnableAutoTrigger: false,
      },
    );

    const report = await orchestrator.analyze('example.com', 'trc_auto_off');
    expect(report.providerHealth?.some((item) => item.provider === 'ai.provider')).toBe(false);
  });

  it('forceAi overrides global auto-trigger kill switch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        '<html><head><title>Good Site</title><meta name="description" content="Desc"></head><body><h1>H</h1></body></html>',
        {
          status: 200,
          headers: { 'content-type': 'text/html' },
        },
      ),
    );

    const orchestrator = new Orchestrator(
      [
        new MetaProvider(providerOptions, 'SiteJSONTest/1.0'),
        new SeoProvider(providerOptions, 'SiteJSONTest/1.0'),
        {
          name: 'traffic.provider',
          run: async () => ({
            provider: 'traffic.provider',
            ok: true,
            latencyMs: 1,
            data: {
              monthlyVisits: 100000,
              globalRank: 1,
              countryRank: 1,
              bounceRate: 10,
              avgVisitDuration: 100,
              pagesPerVisit: 2,
              dataYear: '2026',
              dataMonth: '02',
              trafficSources: null,
              topKeywords: [],
              topRegions: [],
              domainAgeYears: 5,
              cachedAt: null,
              whois: null,
            },
          }),
        },
        {
          name: 'ai.provider',
          run: async () => ({
            provider: 'ai.provider',
            ok: true,
            latencyMs: 1,
            data: {
              classification: { category: 'x', subCategory: 'y', tags: [] },
              business: { summary: '', model: '', targetAudience: '' },
              risk: { sentiment: 'Professional', score: 1, isSpam: false },
            },
          }),
        },
      ],
      createLogger('error'),
      {
        ...runtimeOptions,
        aiEnableAutoTrigger: false,
      },
    );

    const autoReport = await orchestrator.analyze('priority-auto.test', 'trc_priority_auto');
    expect(autoReport.providerHealth?.some((item) => item.provider === 'ai.provider')).toBe(false);

    const forceReport = await orchestrator.analyze('priority-force.test', 'trc_priority_force', { forceAi: true });
    expect(forceReport.providerHealth?.some((item) => item.provider === 'ai.provider')).toBe(true);
  });

  it('respects skipAi even when forceAi is set', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        '<html><head><title>Skip AI</title><meta name="description" content="Desc"></head><body><h1>H</h1></body></html>',
        {
          status: 200,
          headers: { 'content-type': 'text/html' },
        },
      ),
    );

    const orchestrator = new Orchestrator(
      [
        new MetaProvider(providerOptions, 'SiteJSONTest/1.0'),
        new SeoProvider(providerOptions, 'SiteJSONTest/1.0'),
        {
          name: 'traffic.provider',
          run: async () => ({
            provider: 'traffic.provider',
            ok: true,
            latencyMs: 1,
            data: {
              monthlyVisits: 100000,
              globalRank: 10,
              countryRank: 1,
              bounceRate: 10,
              avgVisitDuration: 100,
              pagesPerVisit: 2,
              dataYear: '2026',
              dataMonth: '02',
              trafficSources: null,
              topKeywords: [],
              topRegions: [],
              domainAgeYears: 5,
              cachedAt: null,
              whois: null,
              source: 'rotation',
            },
          }),
        },
        {
          name: 'ai.provider',
          run: async () => ({
            provider: 'ai.provider',
            ok: true,
            latencyMs: 1,
            data: {
              iabCategory: 'Technology & Computing',
              iabSubCategory: 'Software',
              confidence: 0.9,
              tags: ['saas'],
              business: { summary: '', model: '', targetAudience: '' },
              risk: { sentiment: 'Professional', score: 1, isSpam: false },
            },
          }),
        },
      ],
      createLogger('error'),
      runtimeOptions,
    );

    const report = await orchestrator.analyze('skip-ai.test', 'trc_skip_ai', {
      forceAi: true,
      skipAi: true,
    });
    expect(report.providerHealth?.some((item) => item.provider === 'ai.provider')).toBe(false);
    expect(report._meta?.ai?.reason).toBe('skip_ai');
  });

  it('keeps ai provider isolated when API key is missing', async () => {
    const ai = new AiProvider(providerOptions, undefined);
    const result = await ai.run({
      domain: 'example.com',
      url: 'https://example.com',
      traceId: 'trc_ai',
      startedAt: Date.now(),
      htmlSignals: {
        title: 'Example',
        description: 'test',
        techStackDetected: ['Unknown'],
        h1Count: 1,
        h2Count: 1,
        internalLinks: 1,
        externalLinks: 1,
        imagesCount: 1,
        contentLength: 1000,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('AI_API_KEY_MISSING');
  });

  it('treats empty string API keys as missing', async () => {
    const ai = new AiProvider(providerOptions, '', undefined, '', '');
    const result = await ai.run({
      domain: 'example.com',
      url: 'https://example.com',
      traceId: 'trc_ai_empty',
      startedAt: Date.now(),
      htmlSignals: {
        title: 'Example',
        description: 'test',
        techStackDetected: ['Unknown'],
        h1Count: 1,
        h2Count: 1,
        internalLinks: 1,
        externalLinks: 1,
        imagesCount: 1,
        contentLength: 1000,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('AI_API_KEY_MISSING');
  });

  it('builds Chromium host resolver rules from verified public IPv4 addresses', () => {
    expect(buildPinnedHostResolverRules('example.com', ['93.184.216.34', '2001:db8::1'])).toBe(
      'MAP example.com 93.184.216.34, EXCLUDE localhost',
    );
    expect(buildPinnedHostResolverRules('ipv6-only.example', ['2001:db8::1'])).toBe(
      'MAP ipv6-only.example [2001:db8::1], EXCLUDE localhost',
    );
  });

  it('launches browser navigation with pinned DNS rules for the target host', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const page = {
      route: vi.fn(async () => undefined),
      goto: vi.fn(async () => ({ status: () => 200 })),
      waitForLoadState: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => Buffer.from('png')),
      content: vi.fn(async () => '<html><head><title>Example</title></head><body><h1>Example</h1></body></html>'),
      url: vi.fn(() => 'https://example.com'),
      close: vi.fn(async () => undefined),
    };
    const context = {
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => undefined),
    };
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => undefined),
      isConnected: vi.fn(() => true),
    };
    mockChromiumLaunch.mockResolvedValue(browser as any);

    const orchestrator = new Orchestrator(
      [
        new MetaProvider(providerOptions, 'SiteJSONTest/1.0'),
        new SeoProvider(providerOptions, 'SiteJSONTest/1.0'),
      ],
      createLogger('error'),
      {
        ...runtimeOptions,
        browserEnabled: true,
      },
    );

    const report = await orchestrator.analyze('example.com', 'trc_browser_pin', {
      phase: 'browser',
    });

    expect(report.meta?.title).toBe('Example');
    expect(mockChromiumLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        headless: true,
        args: ['--host-resolver-rules=MAP example.com 93.184.216.34, EXCLUDE localhost'],
      }),
    );
  }, 15000);

  it('treats browser challenge pages as blocked content instead of real page data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const page = {
      route: vi.fn(async () => undefined),
      goto: vi.fn(async () => ({ status: () => 503 })),
      waitForLoadState: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => Buffer.from('png')),
      content: vi.fn(async () => '<html><head><title>Just a moment...</title></head><body>cf-chl</body></html>'),
      url: vi.fn(() => 'https://example.com'),
      close: vi.fn(async () => undefined),
    };
    const context = {
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => undefined),
    };
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => undefined),
      isConnected: vi.fn(() => true),
    };
    mockChromiumLaunch.mockResolvedValue(browser as any);

    const orchestrator = new Orchestrator(
      [
        new MetaProvider(providerOptions, 'SiteJSONTest/1.0'),
        new SeoProvider(providerOptions, 'SiteJSONTest/1.0'),
      ],
      createLogger('error'),
      {
        ...runtimeOptions,
        browserEnabled: true,
      },
    );

    const report = await orchestrator.analyze('example.com', 'trc_browser_blocked', {
      phase: 'browser',
    });

    expect(report.meta).toBeUndefined();
    expect(report.seo).toBeUndefined();
    expect(report._meta?.html).toMatchObject({
      source: 'browser',
      blocked: true,
      length: 0,
    });
    expect(report.providerHealth).toEqual(expect.arrayContaining([
      { provider: 'meta.provider', ok: false, errorCode: 'BOT_CHALLENGE_BLOCKED' },
      { provider: 'seo.provider', ok: false, errorCode: 'BOT_CHALLENGE_BLOCKED' },
    ]));
  }, 15000);
});
