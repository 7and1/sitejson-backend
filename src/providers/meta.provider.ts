import type { CrawlContext } from '../core/types.js';
import { providerFailure, providerSuccess } from './base.js';
import type { Provider } from './base.js';
import { fetchDirectWithSafeRedirects, readBoundedText } from './http.js';
import { parseHtmlSignals } from './html.js';
import { detectTechStack } from './tech-stack.js';
import type { MetaData, ProviderRuntimeOptions } from './types.js';

export class MetaProvider implements Provider<MetaData> {
  readonly name = 'meta.provider';

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
        const domData = await ctx.browser.page.evaluate(() => {
          const title = document.title?.trim() ?? '';
          const descMeta = document.querySelector('meta[name="description"]') as HTMLMetaElement | null;
          const description = descMeta?.content?.trim() ?? '';
          const resources = [
            ...Array.from(document.querySelectorAll('script[src]'))
              .map((el) => el.getAttribute('src') ?? ''),
            ...Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]'))
              .map((el) => el.getAttribute('href') ?? ''),
          ]
            .filter(Boolean);

          return {
            title,
            description,
            resources,
            html: document.documentElement?.outerHTML ?? '',
          };
        });

        return providerSuccess(this.name, startedAt, {
          title: domData.title,
          description: domData.description,
          techStackDetected: detectTechStack(domData.html, domData.resources),
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
