import type { CrawlContext } from '../core/types.js';
import { providerFailure, providerSuccess } from './base.js';
import type { Provider } from './base.js';
import { fetchWithRetry, readBoundedText } from './http.js';
import type { DnsData, ProviderRuntimeOptions } from './types.js';

type DnsAnswer = {
  name?: string;
  type?: number;
  TTL?: number;
  data?: string;
};

type DnsJsonResponse = {
  Answer?: DnsAnswer[];
};

const extractRecords = (data: DnsJsonResponse): string[] => {
  return (data.Answer ?? [])
    .map((answer) => answer.data?.replace(/\.$/, '').trim())
    .filter((item): item is string => Boolean(item));
};

const inferDnsProvider = (records: string[]): string => {
  const joined = records.join(' ').toLowerCase();

  if (joined.includes('google')) {
    return 'Google';
  }
  if (joined.includes('outlook') || joined.includes('microsoft')) {
    return 'Microsoft';
  }
  if (joined.includes('zoho')) {
    return 'Zoho';
  }
  if (joined.includes('cloudflare')) {
    return 'Cloudflare';
  }
  return records.length > 0 ? 'Other' : 'Unknown';
};

export class DnsProvider implements Provider<DnsData> {
  readonly name = 'dns.provider';

  constructor(private readonly options: ProviderRuntimeOptions) {}

  async run(ctx: CrawlContext) {
    const startedAt = Date.now();

    try {
      const results = await Promise.allSettled([
        this.query(ctx.domain, 'MX'),
        this.query(ctx.domain, 'NS'),
        this.query(ctx.domain, 'TXT'),
      ]);

      const mxRecords = results[0].status === 'fulfilled' ? results[0].value : [];
      const nsRecords = results[1].status === 'fulfilled' ? results[1].value : [];
      const txtRecords = results[2].status === 'fulfilled' ? results[2].value : [];

      const providerSignal = [...mxRecords, ...nsRecords, ...txtRecords];

      return providerSuccess(this.name, startedAt, {
        provider: inferDnsProvider(providerSignal),
        mxRecords,
        nsRecords,
        txtRecords,
      });
    } catch (error) {
      return providerFailure(
        this.name,
        startedAt,
        'DNS_LOOKUP_FAILED',
        error instanceof Error ? error.message : 'DNS provider failed',
      );
    }
  }

  private async query(domain: string, type: 'MX' | 'NS' | 'TXT'): Promise<string[]> {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`;
    const response = await fetchWithRetry(url, {
      timeoutMs: this.options.timeoutMs ?? 15000,
      retryAttempts: this.options.retryAttempts ?? 2,
      retryBaseMs: this.options.retryBaseMs ?? 250,
      requestInit: {
        headers: {
          accept: 'application/dns-json',
        },
      },
    });

    const text = await readBoundedText(response, 256 * 1024);
    const data = JSON.parse(text) as DnsJsonResponse;
    return extractRecords(data);
  }
}
