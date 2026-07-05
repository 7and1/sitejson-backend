import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiProvider } from '../ai.provider.js';

const aiResponse = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          iabCategory: 'Technology & Computing',
          iabSubCategory: 'Software',
          confidence: 0.93,
          tags: ['saas'],
          business: {
            summary: 'Example summary',
            model: 'SaaS',
            targetAudience: 'Developers',
          },
          risk: {
            sentiment: 'Professional',
            score: 8,
            isSpam: false,
          },
        }),
      },
    },
  ],
};

const buildContext = (options?: { isHighValue?: boolean; radarRank?: number }) => ({
  domain: 'example.com',
  url: 'https://example.com',
  traceId: 'trc-ai',
  startedAt: Date.now(),
  htmlSignals: {
    title: 'Example',
    description: 'Example description',
    techStackDetected: ['React'],
    h1Count: 1,
    h2Count: 0,
    internalLinks: 2,
    externalLinks: 1,
    imagesCount: 1,
    primaryH1: 'Example',
    contentLength: 200,
  },
  browser: {
    screenshotBuffer: Buffer.from('png-bytes'),
  },
  options,
});

describe('AiProvider vision rank gating', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('omits screenshot payloads for low-priority domains outside the vision rank limit', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(aiResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as Response,
    );

    const provider = new AiProvider(
      { timeoutMs: 100, retryAttempts: 0, retryBaseMs: 1 },
      undefined,
      undefined,
      'moonshot-test-key',
      'https://api.example.test/v1',
      'gpt-test',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      100_000,
    );

    const result = await provider.run(buildContext({ radarRank: 250_000 }) as any);

    expect(result.ok).toBe(true);
    const payload = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(typeof payload.messages[1].content).toBe('string');
  });

  it('keeps screenshot payloads for high-value domains within the allowed vision scope', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(aiResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as Response,
    );

    const provider = new AiProvider(
      { timeoutMs: 100, retryAttempts: 0, retryBaseMs: 1 },
      undefined,
      undefined,
      'moonshot-test-key',
      'https://api.example.test/v1',
      'gpt-test',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      100_000,
    );

    const result = await provider.run(buildContext({ radarRank: 500, isHighValue: true }) as any);

    expect(result.ok).toBe(true);
    const payload = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(Array.isArray(payload.messages[1].content)).toBe(true);
    expect(payload.messages[1].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image_url' }),
      ]),
    );
  });

  it('keeps screenshot payloads for unranked domains when content signals are strong', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(aiResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as Response,
    );

    const provider = new AiProvider(
      { timeoutMs: 100, retryAttempts: 0, retryBaseMs: 1 },
      undefined,
      undefined,
      'moonshot-test-key',
      'https://api.example.test/v1',
      'gpt-test',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      100_000,
    );

    const result = await provider.run(buildContext() as any);

    expect(result.ok).toBe(true);
    const payload = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(Array.isArray(payload.messages[1].content)).toBe(true);
    expect(payload.messages[1].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image_url' }),
      ]),
    );
  });

  it('includes a body excerpt in the AI prompt when HTML is available', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(aiResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as Response,
    );

    const provider = new AiProvider(
      { timeoutMs: 100, retryAttempts: 0, retryBaseMs: 1 },
      undefined,
      undefined,
      'moonshot-test-key',
      'https://api.example.test/v1',
      'gpt-test',
    );

    const result = await provider.run({
      ...buildContext(),
      html: `
        <html>
          <body>
            <main>
              <h2>Build software faster</h2>
              <p>Example body copy that explains the product in more detail.</p>
            </main>
          </body>
        </html>
      `,
    } as any);

    expect(result.ok).toBe(true);
    const payload = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(payload.messages[1].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('Body Excerpt: Build software faster Example body copy that explains the product in more detail.'),
        }),
      ]),
    );
  });
});
