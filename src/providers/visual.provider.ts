import sharp from 'sharp';
import type { CrawlContext } from '../core/types.js';
import { providerFailure, providerSuccess } from './base.js';
import type { Provider } from './base.js';
import type { VisualData } from './types.js';
import { ScreenshotStorage } from '../lib/screenshot-storage.js';
import { parseHtmlSignals } from './html.js';
import type { Logger } from 'pino';

const TARGET_WIDTH = 800;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024; // 10 MB cap for raw screenshot buffers

const toHex = (value: number): string => value.toString(16).padStart(2, '0');

const rgbToHex = (r: number, g: number, b: number): string => `#${toHex(r)}${toHex(g)}${toHex(b)}`;

const quantize = (value: number): number => Math.round(value / 16) * 16;

/** A quantized color is neutral (white/black/gray) when its RGB channel spread is ≤ 32 */
const isNeutral = (hex: string): boolean => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (Math.max(r, g, b) - Math.min(r, g, b)) <= 32;
};

const extractColors = async (imageBuffer: Buffer): Promise<{ dominantColor?: string; palette: string[] }> => {
  try {
    const { data, info } = await sharp(imageBuffer)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const buckets = new Map<string, number>();
    const pixelCount = info.width * info.height;
    const sampleStep = Math.max(1, Math.floor(pixelCount / 10000));

    for (let i = 0; i < data.length; i += info.channels * sampleStep) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      const key = rgbToHex(quantize(r), quantize(g), quantize(b));
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }

    const sorted = Array.from(buckets.entries())
      .sort((left, right) => right[1] - left[1])
      .map((entry) => entry[0]);

    const chromatic = sorted.filter((c) => !isNeutral(c));
    const neutral = sorted.filter((c) => isNeutral(c));

    // Prefer chromatic colors; fill remaining slots with neutrals
    const palette = [...chromatic, ...neutral].slice(0, 5);

    return {
      dominantColor: chromatic[0] ?? sorted[0],
      palette,
    };
  } catch {
    return { palette: [] };
  }
};

interface ProxyGridConfig {
  baseUrl: string;
  secret: string;
}

interface SoaxConfig {
  apiUrl: string;
  secret: string;
  country?: string;
  proxyType?: number;
}

export class VisualProvider implements Provider<VisualData> {
  readonly name = 'visual.provider';

  constructor(
    private readonly screenshotStorage: ScreenshotStorage,
    private readonly logger: Logger,
    private readonly proxyGrid?: ProxyGridConfig,
    private readonly soax?: SoaxConfig,
  ) {}

  async run(ctx: CrawlContext) {
    const startedAt = Date.now();

    try {
      let screenshotBuffer: Buffer | null = null;

      // 0. Use pre-captured buffer if available (browser phase: captured before browser close)
      if (ctx.browser?.screenshotBuffer && ctx.browser.screenshotBuffer.byteLength <= MAX_SCREENSHOT_BYTES) {
        screenshotBuffer = ctx.browser.screenshotBuffer;
      }

      // 1. Try browser screenshot (only if no pre-captured buffer)
      if (!screenshotBuffer) {
        const page = ctx.browser?.page;
        if (page) {
          try {
            screenshotBuffer = await page.screenshot({
              type: 'png',
              fullPage: false,
            });
          } catch {
            // Browser page exists but screenshot failed (e.g. navigation error)
          }
        }
      }

      // 2. Fallback: Proxy Grid screenshot (skip for unreachable domains)
      let proxyGridAttempted = false;
      if (!screenshotBuffer && !ctx.metadata?.unreachable && this.proxyGrid?.baseUrl && this.proxyGrid?.secret) {
        proxyGridAttempted = true;
        const pgStart = Date.now();
        screenshotBuffer = await this.fetchProxyGridScreenshot(ctx.url);
        this.logger.info({
          domain: ctx.domain,
          module: 'visual.provider',
          event: 'proxy_grid_screenshot',
          ok: !!screenshotBuffer,
          latencyMs: Date.now() - pgStart,
        });
      }

      // 3. Fallback: SOAX screenshot (skip for unreachable domains AND when ProxyGrid already failed)
      if (!screenshotBuffer && !ctx.metadata?.unreachable && !proxyGridAttempted && this.soax?.apiUrl && this.soax?.secret) {
        const soaxStart = Date.now();
        const soaxResult = await this.fetchSoax(ctx.url);
        screenshotBuffer = soaxResult?.screenshot ?? null;
        const hasHtml = !!(soaxResult?.html);
        this.logger.info({
          domain: ctx.domain,
          module: 'visual.provider',
          event: 'soax_screenshot',
          ok: !!screenshotBuffer,
          hasHtml,
          latencyMs: Date.now() - soaxStart,
        });

        if (soaxResult?.html && !ctx.html) {
          ctx.html = soaxResult.html;
          ctx.htmlSignals = parseHtmlSignals(soaxResult.html);
          ctx.metadata = { ...ctx.metadata, htmlSource: 'soax' };
        }
      }

      if (!screenshotBuffer) {
        return providerFailure(
          this.name,
          startedAt,
          'VISUAL_SCREENSHOT_UNAVAILABLE',
          'No browser, Proxy Grid, or SOAX screenshot available',
        );
      }

      // Resize to target width and convert to webp
      const resizedBuffer = await sharp(screenshotBuffer)
        .resize(TARGET_WIDTH, null, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();

      const colors = await extractColors(screenshotBuffer);
      const storageResult = await this.screenshotStorage.save(ctx.domain, resizedBuffer);

      ctx.browser = {
        ...ctx.browser,
        screenshotPath: storageResult.screenshotPath,
        screenshotUrl: storageResult.screenshotUrl,
        dominantColor: colors.dominantColor,
        palette: colors.palette,
        screenshotBuffer: resizedBuffer,
      };

      return providerSuccess(this.name, startedAt, {
        screenshotPath: storageResult.screenshotPath,
        screenshotUrl: storageResult.screenshotUrl,
        dominantColor: colors.dominantColor,
        palette: colors.palette,
        storage: storageResult.storage,
      });
    } catch (error) {
      return providerFailure(
        this.name,
        startedAt,
        'VISUAL_CAPTURE_FAILED',
        error instanceof Error ? error.message : 'Visual provider failed',
      );
    }
  }

  private async fetchProxyGridScreenshot(url: string): Promise<Buffer | null> {
    try {
      const response = await fetch(this.proxyGrid!.baseUrl.replace(/\/+$/, '') + '/api/search', {
        method: 'POST',
        headers: {
          'x-grid-secret': this.proxyGrid!.secret,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'screenshot', url, force: true }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) return null;

      const payload = await response.json() as { status?: number; image?: string };
      if (!payload.image) return null;

      const decoded = Buffer.from(payload.image, 'base64');
      if (decoded.byteLength > MAX_SCREENSHOT_BYTES) return null;

      return decoded;
    } catch {
      return null;
    }
  }

  private async fetchSoax(url: string): Promise<{ screenshot: Buffer | null; html?: string } | null> {
    try {
      const response = await fetch(this.soax!.apiUrl, {
        method: 'POST',
        headers: {
          'X-SOAX-API-Secret': this.soax!.secret,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url,
          proxy_settings: {
            country: this.soax!.country ?? 'us',
            type: this.soax!.proxyType ?? 1,
          },
          response: { body: true, screenshot: true },
        }),
        signal: AbortSignal.timeout(45_000),
      });

      if (!response.ok) return null;

      const contentType = response.headers.get('content-type') ?? '';

      // Binary image response (no HTML available)
      if (contentType.startsWith('image/')) {
        const buf = Buffer.from(await response.arrayBuffer());
        if (buf.byteLength > MAX_SCREENSHOT_BYTES) return null;
        return { screenshot: buf };
      }

      // JSON response with base64 screenshot + HTML body
      if (contentType.includes('application/json')) {
        const payload = await response.json() as { screenshot?: string; body?: string };
        let screenshot: Buffer | null = null;
        if (payload.screenshot) {
          const decoded = Buffer.from(payload.screenshot, 'base64');
          screenshot = decoded.byteLength <= MAX_SCREENSHOT_BYTES ? decoded : null;
        }
        return { screenshot, html: payload.body?.slice(0, 2 * 1024 * 1024) ?? undefined };
      }

      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.byteLength > MAX_SCREENSHOT_BYTES) return null;
      return { screenshot: buf };
    } catch {
      return null;
    }
  }
}
