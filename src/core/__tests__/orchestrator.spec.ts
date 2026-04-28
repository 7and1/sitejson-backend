import { afterEach, describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
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

const providerOptions = {
  timeoutMs: 100,
  retryAttempts: 0,
  retryBaseMs: 1,
};

const runtimeOptions = {
  timeoutMs: 100,
  retryAttempts: 0,
  retryBaseMs: 1,
  userAgent: 'SiteJSONTest/1.0',
  aiEnableAutoTrigger: true,
  aiAutoTriggerRankLimit: 1000000,
  browserEnabled: false,
  browserTimeoutMs: 100,
  browserHighValueTimeoutMs: 150,
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

describe('Orchestrator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});
