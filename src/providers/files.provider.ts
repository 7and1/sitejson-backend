import type { CrawlContext } from '../core/types.js';
import { providerFailure, providerSuccess } from './base.js';
import type { Provider } from './base.js';
import { fetchDirectWithSafeRedirects, readBoundedText } from './http.js';
import type { FilesData, ProviderRuntimeOptions } from './types.js';

const extractSitemapUrls = (robotsTxt: string): string[] => {
  const urls: string[] = [];
  for (const line of robotsTxt.split(/\r?\n/)) {
    const match = line.match(/^\s*sitemap\s*:\s*(.+)/i);
    if (match) {
      const url = match[1].trim();
      if (url.length > 0) urls.push(url);
    }
  }
  return urls.slice(0, 50);
};

export class FilesProvider implements Provider<FilesData> {
  readonly name = 'files.provider';

  constructor(
    private readonly options: ProviderRuntimeOptions,
    private readonly userAgent: string,
  ) {}

  async run(ctx: CrawlContext) {
    const startedAt = Date.now();
    const baseUrl = `https://${ctx.domain}`;

    try {
      const [robotsResult, hasSitemap] = await Promise.all([
        this.fetchRobotsTxt(`${baseUrl}/robots.txt`),
        this.checkFileExists(`${baseUrl}/sitemap.xml`),
      ]);

      return providerSuccess(this.name, startedAt, {
        hasRobots: robotsResult.exists,
        hasSitemap,
        robotsSitemapUrls: robotsResult.sitemapUrls,
      });
    } catch (error) {
      return providerFailure(
        this.name,
        startedAt,
        'FILES_CHECK_FAILED',
        error instanceof Error ? error.message : 'Files provider failed',
      );
    }
  }

  private async fetchRobotsTxt(url: string): Promise<{ exists: boolean; sitemapUrls: string[] }> {
    try {
      const response = await fetchDirectWithSafeRedirects(url, {
        timeoutMs: this.options.timeoutMs ?? 5000,
        retryAttempts: this.options.retryAttempts ?? 1,
        retryBaseMs: this.options.retryBaseMs ?? 250,
        requestInit: {
          method: 'GET',
          headers: {
            'user-agent': this.userAgent,
            range: 'bytes=0-65535',
          },
        },
      });

      if (!response.ok) return { exists: false, sitemapUrls: [] };

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/html')) return { exists: false, sitemapUrls: [] };

      const text = await readBoundedText(response, 65536);
      return {
        exists: true,
        sitemapUrls: extractSitemapUrls(text),
      };
    } catch {
      return { exists: false, sitemapUrls: [] };
    }
  }

  private async checkFileExists(url: string): Promise<boolean> {
    try {
      const headResponse = await fetchDirectWithSafeRedirects(url, {
        timeoutMs: this.options.timeoutMs ?? 5000,
        retryAttempts: this.options.retryAttempts ?? 1,
        retryBaseMs: this.options.retryBaseMs ?? 250,
        requestInit: {
          method: 'HEAD',
          headers: {
            'user-agent': this.userAgent,
          },
        },
      });

      if (headResponse.ok) {
        return true;
      }

      if (headResponse.status === 405 || headResponse.status === 403) {
        const getResponse = await fetchDirectWithSafeRedirects(url, {
          timeoutMs: this.options.timeoutMs ?? 5000,
          retryAttempts: this.options.retryAttempts ?? 1,
          retryBaseMs: this.options.retryBaseMs ?? 250,
          requestInit: {
            method: 'GET',
            headers: {
              'user-agent': this.userAgent,
              range: 'bytes=0-255',
            },
          },
        });
        return getResponse.ok;
      }

      return false;
    } catch {
      return false;
    }
  }
}
