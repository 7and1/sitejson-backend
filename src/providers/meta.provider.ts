import type { CrawlContext } from '../core/types.js';
import { providerFailure, providerSuccess } from './base.js';
import type { Provider } from './base.js';
import { fetchWithRetry, readBoundedText } from './http.js';
import { parseHtmlSignals } from './html.js';
import type { MetaData, ProviderRuntimeOptions } from './types.js';

const detectTechStackFromDom = (html: string, scriptUrls: string[]): string[] => {
  const loweredHtml = html.toLowerCase();
  const loweredScripts = scriptUrls.map((url) => url.toLowerCase());
  const hits: string[] = [];

  const hasScriptHit = (keyword: string): boolean => loweredScripts.some((url) => url.includes(keyword));

  if (loweredHtml.includes('next.js') || hasScriptHit('/_next/')) {
    hits.push('Next.js');
  }
  if (loweredHtml.includes('react') || hasScriptHit('react')) {
    hits.push('React');
  }
  if (loweredHtml.includes('wp-content') || loweredHtml.includes('wordpress')) {
    hits.push('WordPress');
  }
  if (loweredHtml.includes('shopify') || hasScriptHit('cdn.shopify.com')) {
    hits.push('Shopify');
  }
  if (loweredHtml.includes('cloudflare') || hasScriptHit('cloudflare')) {
    hits.push('Cloudflare');
  }

  return hits.length > 0 ? Array.from(new Set(hits)) : ['Unknown'];
};

export class MetaProvider implements Provider<MetaData> {
  readonly name = 'meta.provider';

  constructor(
    private readonly options: ProviderRuntimeOptions,
    private readonly userAgent: string,
  ) {}

  async run(ctx: CrawlContext) {
    const startedAt = Date.now();
    try {
      if (ctx.browser?.page) {
        const domData = await ctx.browser.page.evaluate(() => {
          const title = document.title?.trim() ?? '';
          const descMeta = document.querySelector('meta[name="description"]') as HTMLMetaElement | null;
          const description = descMeta?.content?.trim() ?? '';
          const scripts = Array.from(document.querySelectorAll('script[src]'))
            .map((el) => el.getAttribute('src') ?? '')
            .filter(Boolean);

          return {
            title,
            description,
            scripts,
            html: document.documentElement?.outerHTML ?? '',
          };
        });

        return providerSuccess(this.name, startedAt, {
          title: domData.title,
          description: domData.description,
          techStackDetected: detectTechStackFromDom(domData.html, domData.scripts),
        });
      }

      if (ctx.htmlSignals) {
        return providerSuccess(this.name, startedAt, {
          title: ctx.htmlSignals.title,
          description: ctx.htmlSignals.description,
          techStackDetected: ctx.htmlSignals.techStackDetected,
        });
      }

      const html = ctx.html ?? await this.fetchHtml(ctx.url);
      const parsed = parseHtmlSignals(html);

      return providerSuccess(this.name, startedAt, {
        title: parsed.title,
        description: parsed.description,
        techStackDetected: parsed.techStackDetected,
      });
    } catch (error) {
      return providerFailure(
        this.name,
        startedAt,
        'META_FETCH_FAILED',
        error instanceof Error ? error.message : 'Meta provider failed',
      );
    }
  }

  private async fetchHtml(url: string): Promise<string> {
    const response = await fetchWithRetry(url, {
      timeoutMs: this.options.timeoutMs ?? 15000,
      retryAttempts: this.options.retryAttempts ?? 2,
      retryBaseMs: this.options.retryBaseMs ?? 250,
      requestInit: {
        headers: {
          'user-agent': this.userAgent,
          accept: 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
      },
    });
    return readBoundedText(response);
  }
}
