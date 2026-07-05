import type { CrawlContext } from '../core/types.js';
import { providerFailure, providerSuccess } from './base.js';
import type { Provider } from './base.js';
import { fetchWithRetry } from './http.js';
import type { AuthorityData, ProviderRuntimeOptions } from './types.js';

const DEFAULT_AHREFS_DR_ENDPOINT = 'https://api.ahrefs.com/v3/public/domain-rating-free';
const AHREFS_LICENSE_URL = 'https://ahrefs.com/legal/domain-rating-license';
const AHREFS_ATTRIBUTION = 'Domain Rating by Ahrefs' as const;

type AhrefsDomainRatingPayload = {
  domain_rating?: {
    domain_rating?: unknown;
    license?: unknown;
  };
  error?: unknown;
};

const normalizeHttpErrorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = message.match(/HTTP_(\d{3})/u);
  const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : null;

  if (status === 429) return 'AHREFS_DR_RATE_LIMITED';
  if (status === 401 || status === 403) return 'AHREFS_DR_ACCESS_RESTRICTED';
  if (status === 400) return 'AHREFS_DR_BAD_REQUEST';
  if (status && status >= 500) return 'AHREFS_DR_UPSTREAM_ERROR';
  if (/timeout|abort/i.test(message)) return 'AHREFS_DR_TIMEOUT';
  return 'AHREFS_DR_FETCH_FAILED';
};

const parseDomainRating = (payload: AhrefsDomainRatingPayload): number | null => {
  const raw = payload.domain_rating?.domain_rating;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return null;
  }

  return Math.max(0, Math.min(100, raw));
};

const parseLicenseUrl = (payload: AhrefsDomainRatingPayload): string => {
  const raw = payload.domain_rating?.license;
  if (typeof raw !== 'string') {
    return AHREFS_LICENSE_URL;
  }

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : AHREFS_LICENSE_URL;
};

export class AhrefsDomainRatingProvider implements Provider<AuthorityData> {
  readonly name = 'authority.provider';

  constructor(
    private readonly options: ProviderRuntimeOptions,
    private readonly userAgent: string,
    private readonly endpoint = DEFAULT_AHREFS_DR_ENDPOINT,
  ) {}

  async run(ctx: CrawlContext) {
    const startedAt = Date.now();
    const url = new URL(this.endpoint);
    url.searchParams.set('target', ctx.domain);

    try {
      const response = await fetchWithRetry(url.toString(), {
        timeoutMs: this.options.timeoutMs ?? 15_000,
        retryAttempts: this.options.retryAttempts ?? 0,
        retryBaseMs: this.options.retryBaseMs ?? 250,
        requestInit: {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'user-agent': this.userAgent,
          },
        },
      });

      const payload = await response.json() as AhrefsDomainRatingPayload;
      if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
        return providerFailure(this.name, startedAt, 'AHREFS_DR_API_ERROR', payload.error);
      }

      const domainRating = parseDomainRating(payload);
      if (domainRating === null) {
        return providerFailure(this.name, startedAt, 'AHREFS_DR_INVALID_RESPONSE', 'Ahrefs DR response did not include a numeric domain rating');
      }

      const data: AuthorityData = {
        domainRating,
        source: 'ahrefs',
        licenseUrl: parseLicenseUrl(payload),
        attribution: AHREFS_ATTRIBUTION,
        fetchedAt: new Date().toISOString(),
      };

      return providerSuccess(this.name, startedAt, data);
    } catch (error) {
      return providerFailure(
        this.name,
        startedAt,
        normalizeHttpErrorCode(error),
        error instanceof Error ? error.message : 'Ahrefs DR provider failed',
      );
    }
  }
}
