import type { CrawlContext } from '../core/types.js';
import { providerFailure, providerSuccess } from './base.js';
import type { Provider } from './base.js';
import { fetchDirectWithSafeRedirects, readBoundedText } from './http.js';
import { parseHtmlSignals } from './html.js';
import type { ProviderRuntimeOptions, SeoData } from './types.js';

export class SeoProvider implements Provider<SeoData> {
  readonly name = 'seo.provider';

  constructor(
    private readonly options: ProviderRuntimeOptions,
    private readonly userAgent: string,
  ) {}

  async run(ctx: CrawlContext) {
    const startedAt = Date.now();
    try {
      if (ctx.metadata?.blocked) {
        return providerFailure(
          this.name,
          startedAt,
          'BOT_CHALLENGE_BLOCKED',
          'Page content was blocked by an anti-bot interstitial',
        );
      }

      if (ctx.browser?.page) {
        const browserData = await ctx.browser.page.evaluate(() => {
          const doc = (globalThis as { document?: any }).document;
          if (!doc) {
            return {
              h1Count: 0,
              h2Count: 0,
              internalLinks: 0,
              externalLinks: 0,
              imagesCount: 0,
            };
          }

          const links = Array.from(doc.querySelectorAll('a[href]'));
          const internalLinks = links.filter((el: any) => {
            const href = (el.getAttribute('href') ?? '').toLowerCase();
            return href.startsWith('/') || href.startsWith('./') || href.startsWith('../') || href.startsWith('#');
          }).length;

          const externalLinks = links.filter((el: any) => {
            const href = (el.getAttribute('href') ?? '').toLowerCase();
            return href.startsWith('http://') || href.startsWith('https://');
          }).length;

          return {
            h1Count: doc.querySelectorAll('h1').length,
            h2Count: doc.querySelectorAll('h2').length,
            internalLinks,
            externalLinks,
            imagesCount: doc.querySelectorAll('img').length,
          };
        });

        return providerSuccess(this.name, startedAt, {
          h1Count: browserData.h1Count,
          h2Count: browserData.h2Count,
          internalLinks: browserData.internalLinks,
          externalLinks: browserData.externalLinks,
          imagesCount: browserData.imagesCount,
        });
      }

      if (ctx.htmlSignals) {
        return providerSuccess(this.name, startedAt, {
          h1Count: ctx.htmlSignals.h1Count,
          h2Count: ctx.htmlSignals.h2Count,
          internalLinks: ctx.htmlSignals.internalLinks,
          externalLinks: ctx.htmlSignals.externalLinks,
          imagesCount: ctx.htmlSignals.imagesCount,
        });
      }

      const html = ctx.html ?? await this.fetchHtml(ctx.url);
      const parsed = parseHtmlSignals(html);

      return providerSuccess(this.name, startedAt, {
        h1Count: parsed.h1Count,
        h2Count: parsed.h2Count,
        internalLinks: parsed.internalLinks,
        externalLinks: parsed.externalLinks,
        imagesCount: parsed.imagesCount,
      });
    } catch (error) {
      return providerFailure(
        this.name,
        startedAt,
        'SEO_FETCH_FAILED',
        error instanceof Error ? error.message : 'SEO provider failed',
      );
    }
  }

  private async fetchHtml(url: string): Promise<string> {
    const response = await fetchDirectWithSafeRedirects(url, {
      timeoutMs: this.options.timeoutMs ?? 15000,
      retryAttempts: this.options.retryAttempts ?? 2,
      retryBaseMs: this.options.retryBaseMs ?? 250,
      requestInit: {
        headers: {
          'user-agent': this.userAgent,
          accept: 'text/html,application/xhtml+xml',
        },
      },
    });
    return readBoundedText(response);
  }
}
