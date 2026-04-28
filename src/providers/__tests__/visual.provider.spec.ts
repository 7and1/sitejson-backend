import { describe, expect, it, vi } from 'vitest';
import { VisualProvider } from '../visual.provider.js';
import type { CrawlContext } from '../../core/types.js';

const buildPngBuffer = (): Buffer => {
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082',
    'hex',
  );
};

describe('VisualProvider', () => {
  it('captures screenshot and stores visual metadata', async () => {
    const screenshotBuffer = buildPngBuffer();

    const storage = {
      save: vi.fn(async () => ({
        storage: 'local' as const,
        screenshotPath: '/tmp/example.png',
      })),
    };

    const provider = new VisualProvider(storage as any, { info: () => {}, warn: () => {} } as any);

    const ctx: CrawlContext = {
      domain: 'example.com',
      url: 'https://example.com',
      traceId: 'trc_visual',
      startedAt: Date.now(),
      browser: {
        page: {
          url: () => 'https://example.com',
          content: async () => '<html></html>',
          screenshot: async () => screenshotBuffer,
          evaluate: async () => null as any,
        },
      },
    };

    const result = await provider.run(ctx);

    expect(result.ok).toBe(true);
    expect(result.data?.storage).toBe('local');
    expect(result.data?.screenshotPath).toBe('/tmp/example.png');
    expect(storage.save).toHaveBeenCalledOnce();
  });

  it('returns failure when browser context is missing', async () => {
    const provider = new VisualProvider({ save: vi.fn() } as any, { info: () => {}, warn: () => {} } as any);

    const result = await provider.run({
      domain: 'example.com',
      url: 'https://example.com',
      traceId: 'trc_visual_fail',
      startedAt: Date.now(),
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VISUAL_SCREENSHOT_UNAVAILABLE');
  });
});
