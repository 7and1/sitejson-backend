import { promises as dns } from 'node:dns';
import { chromium } from 'playwright';
import type { Browser, BrowserContext as PlaywrightBrowserContext, Page } from 'playwright';
import type { Logger } from '../observability/logger.js';
import type { CrawlContext, HtmlSignals, ProviderResult, SiteReport } from './types.js';
import type { Provider } from '../providers/base.js';
import {
  parseAdsData,
  parseAiData,
  parseDnsData,
  parseFilesData,
  parseMetaData,
  parsePublisherData,
  parseRadarData,
  parseSeoData,
  parseTrafficData,
  parseVisualData,
  parseWhoisLookupData,
} from '../providers/types.js';
import {
  buildFetchTraceEntry,
  fetchHtmlWithFallbackChain,
  type FetchTrace,
} from '../providers/http.js';
import { parseHtmlSignals } from '../providers/html.js';

/** Hard cap on HTML stored in context — prevents event-loop blocking during signal extraction. */
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB
const truncateHtml = (html: string): string =>
  html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html;
import { HIGH_VALUE_DOMAINS, SPAM_KEYWORDS } from '../config/ai-rules.js';
import type { BrowserPool } from './browser-pool.js';

const HIGH_VALUE_DOMAIN_SET = new Set(HIGH_VALUE_DOMAINS.map((domain) => domain.toLowerCase()));

const toRankBucket = (rank: number | null | undefined): string | undefined => {
  if (typeof rank !== 'number' || !Number.isFinite(rank) || rank <= 0) {
    return undefined;
  }

  if (rank <= 100) {
    return 'Top 100';
  }

  if (rank <= 1000) {
    return 'Top 1k';
  }

  if (rank <= 10000) {
    return 'Top 10k';
  }

  if (rank <= 100000) {
    return 'Top 100k';
  }

  return 'Global';
};

type RuntimeOptions = {
  timeoutMs: number;
  retryAttempts: number;
  retryBaseMs: number;
  userAgent: string;
  aiEnableAutoTrigger: boolean;
  aiAutoTriggerRankLimit: number;
  browserEnabled: boolean;
  browserTimeoutMs: number;
  browserHighValueTimeoutMs: number;
  browserViewport: { width: number; height: number };
  proxyGridBaseUrl?: string;
  proxyGridSecret?: string;
  soaxApiUrl?: string;
  soaxApiSecret?: string;
  soaxCountry?: string;
  soaxProxyType?: number;
};

type AnalyzeOptions = {
  phase?: 'browser' | 'async' | 'traffic' | 'whois' | 'radar';
  forceAi?: boolean;
  forceRefresh?: boolean;
  aiReclassify?: boolean;
  aiSeedSignals?: Partial<HtmlSignals>;
  isHighValue?: boolean;
  radarRank?: number;
  skipAi?: boolean;
  screenshotUrl?: string;
};

const BROWSER_PROVIDER_SET = new Set([
  'visual.provider',
  'meta.provider',
  'seo.provider',
]);

const ASYNC_PROVIDER_SET = new Set([
  'dns.provider',
  'ads.provider',
  'publisher.provider',
  'files.provider',
  'ai.provider',
]);

const TRAFFIC_PROVIDER_SET = new Set([
  'traffic.provider',
]);

const WHOIS_PROVIDER_SET = new Set([
  'whois.provider',
]);

const RADAR_PROVIDER_SET = new Set([
  'radar.provider',
]);

export class Orchestrator {
  private browserPool?: BrowserPool;

  constructor(
    private readonly providers: Provider[],
    private readonly logger: Logger,
    private readonly providerRuntime: RuntimeOptions,
  ) {}

  setBrowserPool(pool: BrowserPool): void {
    this.browserPool = pool;
  }

  async analyze(domain: string, traceId: string, options?: AnalyzeOptions): Promise<SiteReport> {
    const startedAt = Date.now();
    const phase = options?.phase;
    const context: CrawlContext = {
      domain,
      url: `https://${domain}`,
      traceId,
      startedAt,
      phase,
      options,
      metadata: {
        htmlSource: 'none',
      },
    };

    if (options?.aiReclassify && options.aiSeedSignals) {
      const seed = options.aiSeedSignals;
      context.htmlSignals = {
        title: seed.title?.trim() || domain,
        description: seed.description?.trim() || '',
        techStackDetected: Array.isArray(seed.techStackDetected) ? seed.techStackDetected : [],
        h1Count: seed.h1Count ?? 0,
        h2Count: seed.h2Count ?? 0,
        internalLinks: seed.internalLinks ?? 0,
        externalLinks: seed.externalLinks ?? 0,
        imagesCount: seed.imagesCount ?? 0,
        primaryH1: seed.primaryH1,
        contentLength: seed.contentLength ?? 0,
      };

      if (options.screenshotUrl) {
        try {
          const res = await fetch(options.screenshotUrl, { signal: AbortSignal.timeout(10_000) });
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            context.browser = { screenshotBuffer: buf };
            this.logger.info({ trace_id: traceId, domain, module: 'orchestrator', event: 'screenshot_fetched', bytes: buf.length });
          }
        } catch {
          this.logger.warn({ trace_id: traceId, domain, module: 'orchestrator', event: 'screenshot_fetch_failed' });
        }
      }
    }

    const laneTiming = {
      browser: 0,
      fetch: 0,
      ai: 0,
    };

    const fetchTrace: FetchTrace[] = [];

    // Async and traffic phases skip browser entirely
    const needsBrowser = !options?.aiReclassify && (phase === 'browser' || !phase);

    const browserResources: { browser: Browser | null; context: PlaywrightBrowserContext | null; page: Page | null } = {
      browser: null,
      context: null,
      page: null,
    };

    try {
      if (needsBrowser && this.providerRuntime.browserEnabled) {
        const laneBrowserStartedAt = Date.now();
        const browserAttemptStartedAt = Date.now();
        const browserTimeoutMs = this.resolveBrowserTimeout(options);

        // --- Reachability gate: DNS + HTTP pre-check ---
        let reachable = true;
        let useHttpUrl: string | null = null;

        try {
          await dns.resolve4(domain);
        } catch {
          try {
            await dns.resolve6(domain);
            this.logger.info({ trace_id: traceId, domain, module: 'orchestrator', event: 'precheck_dns_ipv6_ok' });
          } catch {
            reachable = false;
            context.metadata = { ...context.metadata, unreachable: true };
            this.logger.info({ trace_id: traceId, domain, module: 'orchestrator', event: 'precheck_dns_failed' });
            fetchTrace.push(buildFetchTraceEntry('browser', 'direct', browserAttemptStartedAt, new Error('DNS_NOT_RESOLVED')));
          }
        }

        if (reachable) {
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 3000);
            try {
              await fetch(`https://${domain}`, { method: 'HEAD', signal: ctrl.signal, redirect: 'follow' });
            } catch {
              // HTTPS failed, try HTTP
              const ctrl2 = new AbortController();
              const timer2 = setTimeout(() => ctrl2.abort(), 3000);
              try {
                await fetch(`http://${domain}`, { method: 'HEAD', signal: ctrl2.signal, redirect: 'follow' });
                useHttpUrl = `http://${domain}`;
              } catch {
                this.logger.info({ trace_id: traceId, domain, module: 'orchestrator', event: 'precheck_http_failed_soft' });
              } finally {
                clearTimeout(timer2);
              }
            } finally {
              clearTimeout(timer);
            }
          } catch {
            // pre-check itself errored, proceed with browser anyway
          }
        }

        if (reachable) {
          const targetUrl = useHttpUrl ?? context.url;
          if (useHttpUrl) {
            context.url = useHttpUrl;
            this.logger.info({ trace_id: traceId, domain, module: 'orchestrator', event: 'precheck_http_fallback' });
          }

          try {
            browserResources.browser = this.browserPool
              ? await this.browserPool.acquire()
              : await chromium.launch({ headless: true });
            browserResources.context = await browserResources.browser.newContext({
              viewport: this.providerRuntime.browserViewport,
              userAgent: this.providerRuntime.userAgent,
              locale: 'en-US',
              timezoneId: 'America/Los_Angeles',
              extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
              ignoreHTTPSErrors: true,
            });
            browserResources.page = await browserResources.context.newPage();

            // Block heavy resources + tracking scripts to speed up navigation
            await browserResources.page.route('**/*', (route) => {
              const type = route.request().resourceType();
              if (type === 'font' || type === 'media') {
                return route.abort();
              }
              const url = route.request().url();
              if (/google-analytics|googletagmanager|facebook\.net|connect\.facebook|hotjar|doubleclick|adsbygoogle|googlesyndication|tracking|pixel/.test(url)) {
                return route.abort();
              }
              return route.continue();
            });

            const response = await browserResources.page.goto(targetUrl, {
              waitUntil: 'domcontentloaded',
              timeout: browserTimeoutMs,
            });

            // Wait briefly for late scripts, but don't fail on timeout
            await browserResources.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

            // Capture screenshot + HTML in parallel, then release browser immediately
            const [screenshotBuffer, html] = await Promise.all([
              browserResources.page.screenshot({ type: 'png', fullPage: false }).catch(() => null),
              browserResources.page.content().catch(async () => {
                // Retry once after brief wait -- page may still be navigating
                await new Promise((r) => setTimeout(r, 500));
                return browserResources.page!.content().catch(() => '');
              }),
            ]);

            const finalUrl = browserResources.page.url();

            // Close page + context IMMEDIATELY — release resources before running providers
            try { await browserResources.page.close(); } catch { /* noop */ }
            try { await browserResources.context.close(); } catch { /* noop */ }
            if (this.browserPool) {
              this.browserPool.release(browserResources.browser);
            } else {
              try { await browserResources.browser.close(); } catch { /* noop */ }
            }
            browserResources.page = null;
            browserResources.context = null;
            browserResources.browser = null;

            context.html = truncateHtml(html);
            context.htmlSignals = parseHtmlSignals(context.html);
            context.url = finalUrl;
            context.metadata = { ...context.metadata, htmlSource: 'browser' };
            context.browser = {
              finalUrl,
              screenshotBuffer: screenshotBuffer ?? undefined,
            };

            this.logger.info({
              trace_id: traceId,
              domain,
              module: 'orchestrator',
              event: 'browser_fetch',
              ok: true,
              hasScreenshot: !!screenshotBuffer,
              htmlLength: html.length,
              statusCode: response?.status(),
              latencyMs: Date.now() - browserAttemptStartedAt,
            });
            fetchTrace.push(buildFetchTraceEntry('browser', 'direct', browserAttemptStartedAt));
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            const errorType = errMsg.includes('ERR_NAME_NOT_RESOLVED') ? 'DNS'
              : errMsg.includes('CERT') ? 'CERT'
              : errMsg.includes('Timeout') ? 'TIMEOUT'
              : errMsg.includes('CONNECTION_REFUSED') ? 'CONN_REFUSED'
              : 'OTHER';
            this.logger.warn({
              trace_id: traceId,
              domain,
              module: 'orchestrator',
              event: 'browser_fetch',
              ok: false,
              errorType,
              error: errMsg,
              latencyMs: Date.now() - browserAttemptStartedAt,
            });
            fetchTrace.push(buildFetchTraceEntry('browser', 'direct', browserAttemptStartedAt, error));

            // Ensure browser is cleaned up on failure
            try { await browserResources.page?.close(); } catch { /* noop */ }
            try { await browserResources.context?.close(); } catch { /* noop */ }
            if (this.browserPool && browserResources.browser) {
              this.browserPool.release(browserResources.browser);
            } else {
              try { await browserResources.browser?.close(); } catch { /* noop */ }
            }
            browserResources.page = null;
            browserResources.context = null;
            browserResources.browser = null;
          }
        }

        laneTiming.browser = Date.now() - laneBrowserStartedAt;
      }

      // HTML fallback chain: only for browser phase (async/traffic/radar providers don't use HTML)
      if (!context.html && needsBrowser) {
        const fallback = await fetchHtmlWithFallbackChain(context.url, {
          timeoutMs: this.providerRuntime.timeoutMs,
          retryAttempts: this.providerRuntime.retryAttempts,
          retryBaseMs: this.providerRuntime.retryBaseMs,
          userAgent: this.providerRuntime.userAgent,
          logger: this.logger,
          domain,
          proxyGrid: {
            baseUrl: this.providerRuntime.proxyGridBaseUrl,
            secret: this.providerRuntime.proxyGridSecret,
            timeoutMs: this.providerRuntime.timeoutMs,
            retryAttempts: this.providerRuntime.retryAttempts,
            retryBaseMs: this.providerRuntime.retryBaseMs,
          },
          soax: {
            apiUrl: this.providerRuntime.soaxApiUrl,
            secret: this.providerRuntime.soaxApiSecret,
            country: this.providerRuntime.soaxCountry,
            proxyType: this.providerRuntime.soaxProxyType,
            timeoutMs: this.providerRuntime.timeoutMs,
            retryAttempts: this.providerRuntime.retryAttempts,
            retryBaseMs: this.providerRuntime.retryBaseMs,
          },
        });

        if (fallback?.html) {
          context.html = truncateHtml(fallback.html);
          context.htmlSignals = parseHtmlSignals(context.html);
          context.metadata = { ...context.metadata, htmlSource: fallback.source };
          fetchTrace.push(...fallback.trace);
        } else {
          this.logger.warn({
            trace_id: traceId,
            domain,
            module: 'orchestrator',
            event: 'bootstrap_html_fetch_failed',
          });
        }
      }

      this.logger.info({ trace_id: traceId, domain, module: 'orchestrator', event: 'analysis_started', phase });

      // Select providers based on phase
      let selectedProviders = this.providers;
      if (phase === 'browser') {
        selectedProviders = options?.aiReclassify
          ? this.providers.filter((p) => p.name === 'ai.provider')
          : this.providers.filter((p) => BROWSER_PROVIDER_SET.has(p.name));
      } else if (phase === 'async') {
        selectedProviders = this.providers.filter((p) => ASYNC_PROVIDER_SET.has(p.name));
      } else if (phase === 'traffic') {
        selectedProviders = this.providers.filter((p) => TRAFFIC_PROVIDER_SET.has(p.name));
      } else if (phase === 'whois') {
        selectedProviders = this.providers.filter((p) => WHOIS_PROVIDER_SET.has(p.name));
      } else if (phase === 'radar') {
        selectedProviders = this.providers.filter((p) => RADAR_PROVIDER_SET.has(p.name));
      }

      const nonAiProviders = selectedProviders.filter((p) => p.name !== 'ai.provider');
      const aiProviders = selectedProviders.filter((p) => p.name === 'ai.provider');

      const fetchLaneStartedAt = Date.now();
      const results = await this.runProviders(nonAiProviders, context, domain, traceId);
      laneTiming.fetch = Date.now() - fetchLaneStartedAt;

      const initialReport = this.mergeResults(domain, results);

      const aiLaneStartedAt = Date.now();
      const aiDecision = this.evaluateAiTrigger(initialReport, context, domain, options);
      const aiTriggered = aiDecision.shouldRun && aiProviders.length > 0;
      const aiReason = aiDecision.shouldRun && aiProviders.length === 0
        ? 'ai_provider_missing'
        : aiDecision.reason;

      if (aiTriggered) {
        const aiResults = await this.runProviders(aiProviders, context, domain, traceId);
        results.push(...aiResults);
      } else if (aiProviders.length > 0) {
        this.logger.info({
          trace_id: traceId,
          domain,
          module: 'orchestrator',
          event: 'ai_provider_skipped',
          reason: aiReason,
        });
      }
      laneTiming.ai = Date.now() - aiLaneStartedAt;

      const report = this.mergeResults(domain, results);

      report._meta = {
        ...report._meta,
        timing: {
          ...(report._meta?.timing ?? {}),
          lane_browser_ms: laneTiming.browser,
          lane_fetch_ms: laneTiming.fetch,
          lane_ai_ms: laneTiming.ai,
          total_ms: Date.now() - startedAt,
        },
        html: {
          ...(report._meta?.html ?? {}),
          source: context.metadata?.htmlSource ?? 'none',
          length: context.html?.length ?? 0,
          primary_h1: context.htmlSignals?.primaryH1,
        },
        ai: {
          ...(report._meta?.ai ?? {}),
          evaluated: aiProviders.length > 0,
          triggered: aiTriggered,
          reason: aiReason,
        },
        debug: {
          ...(report._meta?.debug ?? {}),
          fallback_path: {
            browser: context.metadata?.htmlSource ?? 'none',
            traffic: this.resolveTrafficFallbackPath(results),
          },
        },
      };

      this.logger.info({
        trace_id: traceId,
        domain,
        module: 'orchestrator',
        event: 'analysis_completed',
        phase,
        latency_ms: Date.now() - startedAt,
      });

      return report;
    } finally {
      // Safety net: clean up browser if still open (e.g. non-browser phase or unexpected error)
      try { await browserResources.page?.close(); } catch { /* noop */ }
      try { await browserResources.context?.close(); } catch { /* noop */ }
      if (this.browserPool && browserResources.browser) {
        this.browserPool.release(browserResources.browser);
      } else {
        try { await browserResources.browser?.close(); } catch { /* noop */ }
      }
    }
  }

  private async runProviders(
    providers: Provider[],
    context: CrawlContext,
    domain: string,
    traceId: string,
  ): Promise<ProviderResult[]> {
    if (providers.length === 0) {
      return [];
    }

    const settledResults = await Promise.allSettled(
      providers.map((provider) => provider.run(context)),
    );

    const results: ProviderResult[] = [];
    for (let i = 0; i < settledResults.length; i++) {
      const settled = settledResults[i];
      const provider = providers[i];

      if (settled.status === 'fulfilled') {
        results.push(settled.value);
        if (!settled.value.ok) {
          this.logger.warn({
            trace_id: traceId,
            domain,
            module: provider.name,
            event: 'provider_failed',
            error_code: settled.value.error?.code,
          });
        }
      } else {
        this.logger.error({
          trace_id: traceId,
          domain,
          module: provider.name,
          event: 'provider_crashed',
          error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
        });
        results.push({
          provider: provider.name,
          ok: false,
          latencyMs: 0,
          data: null,
          error: {
            code: 'PROVIDER_CRASHED',
            message: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
          },
        });
      }
    }

    return results;
  }

  private resolveBrowserTimeout(options?: AnalyzeOptions): number {
    const defaultTimeoutMs = this.providerRuntime.browserTimeoutMs;
    const highValueTimeoutMs = this.providerRuntime.browserHighValueTimeoutMs;

    if (highValueTimeoutMs <= defaultTimeoutMs) {
      return defaultTimeoutMs;
    }

    if (options?.isHighValue) {
      return highValueTimeoutMs;
    }

    if (typeof options?.radarRank === 'number' && options.radarRank > 0 && options.radarRank <= 100_000) {
      return highValueTimeoutMs;
    }

    return defaultTimeoutMs;
  }

  private evaluateAiTrigger(
    report: SiteReport,
    context: CrawlContext,
    domain: string,
    options?: AnalyzeOptions,
  ): { shouldRun: boolean; reason: 'skip_ai' | 'force_ai' | 'auto' | 'disabled' | 'no_signal' | 'spam_guard' | 'ai_provider_missing' | 'no_rank' } {
    if (options?.skipAi) {
      return { shouldRun: false, reason: 'skip_ai' };
    }

    if (options?.forceAi) {
      return { shouldRun: true, reason: 'force_ai' };
    }

    if (!this.providerRuntime.aiEnableAutoTrigger) {
      return { shouldRun: false, reason: 'disabled' };
    }

    const normalizedDomain = domain.toLowerCase();
    for (const highValueDomain of HIGH_VALUE_DOMAIN_SET) {
      if (normalizedDomain === highValueDomain || normalizedDomain.endsWith(`.${highValueDomain}`)) {
        return { shouldRun: true, reason: 'auto' };
      }
    }

    const title = (report.meta?.title ?? '').trim();
    const normalizedTitle = title.toLowerCase();
    if (SPAM_KEYWORDS.some((keyword) => normalizedTitle.includes(keyword))) {
      return { shouldRun: false, reason: 'spam_guard' };
    }

    const htmlLength = context.html?.trim().length ?? (context.htmlSignals?.contentLength ?? 0);
    const hasDescription = Boolean(report.meta?.description?.trim());
    const hasH1 = Boolean(report.seo?.h1Count && report.seo.h1Count > 0);
    const hasLinks = Boolean(report.seo && ((report.seo.internalLinks ?? 0) > 0 || (report.seo.externalLinks ?? 0) > 0));

    // Relaxed signal detection: content quality > just HTML length
    if (htmlLength === 0) {
      return { shouldRun: false, reason: 'no_signal' };
    }

    if (htmlLength < 32 && !hasDescription && !hasH1) {
      return { shouldRun: false, reason: 'no_signal' };
    }

    if (!title || title.length === 0) {
      // Allow AI if we have other signals
      if (!hasDescription && !hasH1) {
        return { shouldRun: false, reason: 'no_signal' };
      }
    }

    const globalRank = options?.radarRank ?? report.radar?.globalRank ?? report.trafficData?.globalRank ?? 0;
    if (
      typeof globalRank === 'number'
      && globalRank > 0
      && globalRank <= this.providerRuntime.aiAutoTriggerRankLimit
    ) {
      return { shouldRun: true, reason: 'auto' };
    }

    if (title.length >= 2 && (hasDescription || hasH1 || hasLinks)) {
      return { shouldRun: true, reason: 'auto' };
    }

    return { shouldRun: false, reason: 'no_rank' };
  }

  private resolveTrafficFallbackPath(results: ProviderResult[]): 'similarweb_api' | 'rotation' | 'flaresolverr' | 'proxy_grid' | 'soax' | 'none' {
    const trafficResult = results.find((item) => item.provider === 'traffic.provider');
    if (!trafficResult?.data || typeof trafficResult.data !== 'object') {
      return 'none';
    }

    const source = (trafficResult.data as { source?: unknown }).source;
    if (source === 'similarweb_api' || source === 'rotation' || source === 'flaresolverr' || source === 'proxy_grid' || source === 'soax') {
      return source;
    }

    return 'none';
  }

  private mergeResults(domain: string, results: ProviderResult[]): SiteReport {
    const report: SiteReport = {
      domain,
      updatedAt: new Date().toISOString(),
      providerHealth: [],
    };

    for (const result of results) {
      report.providerHealth?.push({
        provider: result.provider,
        ok: result.ok,
        errorCode: result.error?.code,
      });

      if (!result.ok || !result.data) {
        continue;
      }

      switch (result.provider) {
        case 'visual.provider': {
          const visual = parseVisualData(result.data);
          if (visual) {
            report.visual = {
              screenshotUrl: visual.screenshotUrl,
              screenshotPath: visual.screenshotPath,
              dominantColor: visual.dominantColor,
              palette: visual.palette,
              storage: visual.storage,
            };
          }
          break;
        }
        case 'meta.provider': {
          const meta = parseMetaData(result.data);
          if (meta) {
            report.meta = {
              title: meta.title,
              description: meta.description,
              techStackDetected: meta.techStackDetected,
            };
          }
          break;
        }
        case 'seo.provider': {
          const seo = parseSeoData(result.data);
          if (seo) {
            report.seo = {
              h1Count: seo.h1Count,
              h2Count: seo.h2Count,
              internalLinks: seo.internalLinks,
              externalLinks: seo.externalLinks,
              imagesCount: seo.imagesCount,
            };
          }
          break;
        }
        case 'files.provider': {
          const files = parseFilesData(result.data);
          if (files) {
            report.files = {
              hasRobots: files.hasRobots,
              hasSitemap: files.hasSitemap,
              robotsSitemapUrls: files.robotsSitemapUrls,
            };
          }
          break;
        }
        case 'dns.provider': {
          const dns = parseDnsData(result.data);
          if (dns) {
            report.dns = {
              provider: dns.provider,
              mxRecords: dns.mxRecords,
              nsRecords: dns.nsRecords,
              txtRecords: dns.txtRecords,
            };
          }
          break;
        }
        case 'ads.provider': {
          const ads = parseAdsData(result.data);
          if (ads) {
            report.ads = {
              isAdvertiser: ads.isAdvertiser,
              advertiserIds: ads.advertiserIds,
              advertiserNames: ads.advertiserNames,
              resultCount: ads.resultCount,
              transparencySignals: ads.transparencySignals,
            };
          }
          break;
        }
        case 'publisher.provider': {
          const publisher = parsePublisherData(result.data);
          if (publisher) {
            report.publisher = {
              hasAdsTxt: publisher.hasAdsTxt,
              adSystems: publisher.adSystems,
              directCount: publisher.directCount,
              resellerCount: publisher.resellerCount,
              monetizationSignals: publisher.monetizationSignals,
            };
          }
          break;
        }
        case 'traffic.provider': {
          const traffic = parseTrafficData(result.data);
          if (traffic) {
            report.trafficData = {
              monthlyVisits: traffic.monthlyVisits,
              globalRank: traffic.globalRank,
              countryRank: traffic.countryRank,
              bounceRate: traffic.bounceRate,
              avgVisitDuration: traffic.avgVisitDuration,
              pagesPerVisit: traffic.pagesPerVisit,
              topCountry: traffic.topRegions[0]?.country,
              topRegions: traffic.topRegions,
              topKeywords: traffic.topKeywords,
              trafficSources: traffic.trafficSources ?? undefined,
            };

            if (!report.radar?.globalRank) {
              report.radar = {
                globalRank: traffic.globalRank,
                rankBucket: toRankBucket(traffic.globalRank),
              };
            }
          }
          break;
        }
        case 'whois.provider': {
          const whoisLookup = parseWhoisLookupData(result.data);
          if (whoisLookup) {
            report.trafficData = {
              ...(report.trafficData ?? {}),
              domainAgeYears: whoisLookup.domainAgeYears,
              whois: whoisLookup.whois ?? undefined,
            };
          }
          break;
        }
        case 'radar.provider': {
          const radar = parseRadarData(result.data);
          if (radar) {
            report.radar = {
              globalRank: radar.globalRank,
              rankBucket: radar.rankBucket ?? toRankBucket(radar.globalRank),
              sourceTimestamp: radar.sourceTimestamp,
              categories: radar.categories,
              queued: radar.queued,
            };
          }
          break;
        }
        case 'ai.provider': {
          const ai = parseAiData(result.data);
          if (ai) {
            report.taxonomy = {
              iabCategory: ai.iabCategory,
              iabSubCategory: ai.iabSubCategory,
              confidence: ai.confidence,
              tags: ai.tags,
            };
            report.aiAnalysis = {
              business: ai.business,
              risk: ai.risk,
              visualAnalysis: ai.visualAnalysis,
            };
          }
          break;
        }
        default:
          break;
      }
    }

    return report;
  }
}
