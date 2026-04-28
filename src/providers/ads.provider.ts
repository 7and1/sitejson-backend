import { URLSearchParams } from 'node:url';
import type { CrawlContext } from '../core/types.js';
import { providerFailure, providerSuccess } from './base.js';
import type { Provider } from './base.js';
import { fetchWithProxyRotation, fetchWithRetry, parseProxyList, readBoundedText } from './http.js';
import type { ProxyConfig } from './http.js';
import type { AdsData, ProviderRuntimeOptions } from './types.js';

const ADS_RPC_URL = 'https://adstransparency.google.com/anji/_/rpc/SearchService/SearchCreatives?authuser=';

const extractJsonString = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return trimmed;
  }

  const start = Math.min(
    ...[trimmed.indexOf('{'), trimmed.indexOf('[')].filter((index) => index >= 0),
  );
  return Number.isFinite(start) && start >= 0 ? trimmed.slice(start) : trimmed;
};

const parseAdsResponse = (rawText: string): AdsData => {
  const advertiserIds = Array.from(new Set(rawText.match(/AR\d{10,}/g) ?? []));

  const advertiserNames = Array.from(new Set(
    Array.from(rawText.matchAll(/"12"\s*:\s*"([^\"]+)"/g)).map((match) => match[1]),
  ));

  const countFromJson = (() => {
    const jsonText = extractJsonString(rawText);
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      const countValue = parsed['2'];
      return typeof countValue === 'number' ? countValue : advertiserIds.length;
    } catch {
      return advertiserIds.length;
    }
  })();

  const transparencySignals = [
    advertiserIds.length > 0 ? 'has_advertiser_id' : 'no_advertiser_id',
    countFromJson > 0 ? 'has_creative_results' : 'no_creative_results',
  ];

  return {
    isAdvertiser: advertiserIds.length > 0 || countFromJson > 0,
    advertiserIds,
    advertiserNames,
    resultCount: countFromJson,
    transparencySignals,
  };
};

export class AdsProvider implements Provider<AdsData> {
  readonly name = 'ads.provider';
  private readonly primaryProxies: ProxyConfig[];
  private readonly fallbackProxies: ProxyConfig[];

  constructor(
    private readonly options: ProviderRuntimeOptions,
    private readonly userAgent: string,
    private readonly regionCode: number = 2840,
    proxyList?: string,
    fallbackProxyList?: string,
    private readonly maxPrimaryProxies: number = 6,
  ) {
    this.primaryProxies = proxyList ? parseProxyList(proxyList) : [];
    this.fallbackProxies = fallbackProxyList ? parseProxyList(fallbackProxyList) : [];
  }

  async run(ctx: CrawlContext) {
    const startedAt = Date.now();

    try {
      const payload = {
        2: 40,
        3: {
          8: [this.regionCode],
          12: {
            1: ctx.domain,
            2: true,
          },
        },
        7: {
          1: 1,
          2: 0,
          3: this.regionCode,
        },
      };

      const body = new URLSearchParams({
        'f.req': JSON.stringify(payload),
      });

      const requestInit: RequestInit = {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-same-domain': '1',
          'user-agent': this.userAgent,
        },
        body: body.toString(),
      };

      const hasProxyPool = this.primaryProxies.length > 0 || this.fallbackProxies.length > 0;
      const response = hasProxyPool
        ? await fetchWithProxyRotation(ADS_RPC_URL, {
            timeoutMs: this.options.timeoutMs ?? 15000,
            retryBaseMs: this.options.retryBaseMs ?? 250,
            requestInit,
            primaryProxies: this.primaryProxies,
            fallbackProxies: this.fallbackProxies,
            maxPrimaryProxies: this.maxPrimaryProxies,
          })
        : await fetchWithRetry(ADS_RPC_URL, {
            timeoutMs: this.options.timeoutMs ?? 15000,
            retryAttempts: this.options.retryAttempts ?? 2,
            retryBaseMs: this.options.retryBaseMs ?? 250,
            requestInit,
          });

      const rawText = await readBoundedText(response);
      const parsed = parseAdsResponse(rawText);

      return providerSuccess(this.name, startedAt, parsed);
    } catch (error) {
      return providerFailure(
        this.name,
        startedAt,
        'ADS_FETCH_FAILED',
        error instanceof Error ? error.message : 'Ads provider failed',
      );
    }
  }
}
