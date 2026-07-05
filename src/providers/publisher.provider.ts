import type { CrawlContext } from '../core/types.js';
import { providerFailure, providerSuccess } from './base.js';
import type { Provider } from './base.js';
import { fetchDirectWithSafeRedirects, readBoundedText } from './http.js';
import type { ProviderRuntimeOptions, PublisherData } from './types.js';

const normalizeAdsTxtLine = (line: string): string => {
  return line.split('#', 1)[0]?.trim() ?? '';
};

const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const normalizeAdSystemToken = (raw: string): string | null => {
  const token = raw.trim().toLowerCase();
  if (!token || /[\s<>"'`]/.test(token)) {
    return null;
  }

  if (token.startsWith('ownerdomain=')) {
    const ownerDomain = token.slice('ownerdomain='.length).trim();
    return DOMAIN_PATTERN.test(ownerDomain) ? ownerDomain : null;
  }

  return DOMAIN_PATTERN.test(token) ? token : null;
};

const parseAdsTxt = (content: string): { adSystems: string[]; hasAdsTxt: boolean; directCount: number; resellerCount: number } => {
  const adSystems = new Set<string>();
  let directCount = 0;
  let resellerCount = 0;
  const cleanedLines = content
    .split(/\r?\n/g)
    .map((line) => normalizeAdsTxtLine(line))
    .filter((line) => line.length > 0);

  for (const line of cleanedLines) {
    if (line.startsWith('<')) continue;
    const parts = line.split(',').map((part) => part.trim());
    const system = normalizeAdSystemToken(parts[0] ?? '');
    if (system) {
      adSystems.add(system);
    }
    const relationship = parts[2]?.toUpperCase();
    if (relationship === 'DIRECT') directCount++;
    else if (relationship === 'RESELLER') resellerCount++;
  }

  return {
    hasAdsTxt: adSystems.size > 0 || directCount > 0 || resellerCount > 0,
    adSystems: Array.from(adSystems).slice(0, 50),
    directCount,
    resellerCount,
  };
};

export class PublisherProvider implements Provider<PublisherData> {
  readonly name = 'publisher.provider';

  constructor(
    private readonly options: ProviderRuntimeOptions,
    private readonly userAgent: string,
  ) {}

  async run(ctx: CrawlContext) {
    const startedAt = Date.now();

    try {
      const adsUrl = `https://${ctx.domain}/ads.txt`;
      const response = await fetchDirectWithSafeRedirects(adsUrl, {
        timeoutMs: this.options.timeoutMs ?? 10000,
        retryAttempts: this.options.retryAttempts ?? 1,
        retryBaseMs: this.options.retryBaseMs ?? 250,
        requestInit: {
          headers: {
            'user-agent': this.userAgent,
            accept: 'text/plain,*/*',
          },
        },
      });

      if (response.status !== 200) {
        return providerSuccess(this.name, startedAt, {
          hasAdsTxt: false,
          adSystems: [],
          directCount: 0,
          resellerCount: 0,
          monetizationSignals: ['missing_ads_txt'],
        });
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/html')) {
        return providerSuccess(this.name, startedAt, {
          hasAdsTxt: false,
          adSystems: [],
          directCount: 0,
          resellerCount: 0,
          monetizationSignals: ['missing_ads_txt'],
        });
      }

      const content = await readBoundedText(response, 512 * 1024);
      // Guard against HTML documents being served at /ads.txt, but tolerate stray HTML/script lines.
      if (/<(?:!doctype|html|head|body)\b/i.test(content)) {
        return providerSuccess(this.name, startedAt, {
          hasAdsTxt: false,
          adSystems: [],
          directCount: 0,
          resellerCount: 0,
          monetizationSignals: ['missing_ads_txt'],
        });
      }
      const parsed = parseAdsTxt(content);

      const monetizationSignals = [
        parsed.hasAdsTxt ? 'has_ads_txt' : 'missing_ads_txt',
        parsed.adSystems.length > 0 ? 'has_ad_systems' : 'no_ad_systems',
      ];

      return providerSuccess(this.name, startedAt, {
        hasAdsTxt: parsed.hasAdsTxt,
        adSystems: parsed.adSystems,
        directCount: parsed.directCount,
        resellerCount: parsed.resellerCount,
        monetizationSignals,
      });
    } catch {
      return providerSuccess(this.name, startedAt, {
        hasAdsTxt: false,
        adSystems: [],
        directCount: 0,
        resellerCount: 0,
        monetizationSignals: ['missing_ads_txt'],
      });
    }
  }
}
