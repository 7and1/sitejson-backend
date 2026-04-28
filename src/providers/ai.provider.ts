import type { CrawlContext } from '../core/types.js';
import type { Logger } from '../observability/logger.js';
import { providerFailure, providerSuccess } from './base.js';
import type { Provider } from './base.js';
import { fetchWithRetry } from './http.js';
import type { AiData, ProviderRuntimeOptions } from './types.js';

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

type AiBackend = 'gemini' | 'openai' | 'openai-responses' | 'anthropic';

type AiProviderConfig = {
  apiKey: string;
  model: string;
  baseUrl: string;
  backend: AiBackend;
};

const resolveConfig = (
  geminiKey?: string,
  geminiModel?: string,
  moonshotKey?: string,
  baseUrl?: string,
  model?: string,
): AiProviderConfig | null => {
  if (moonshotKey) {
    const isAnthropic = moonshotKey.startsWith('sk-kimi-') || baseUrl?.includes('kimi.com');

    if (isAnthropic) {
      return {
        apiKey: moonshotKey,
        model: (!model || model === 'kimi') ? 'claude-3-5-sonnet-20241022' : model,
        baseUrl: baseUrl || 'https://api.kimi.com/coding',
        backend: 'anthropic',
      };
    }

    return {
      apiKey: moonshotKey,
      model: model || 'moonshot-v1-8k',
      baseUrl: baseUrl || 'https://api.moonshot.cn/v1',
      backend: 'openai',
    };
  }

  if (geminiKey) {
    return {
      apiKey: geminiKey,
      model: geminiModel || 'gemini-1.5-flash',
      baseUrl: 'https://generativelanguage.googleapis.com',
      backend: 'gemini',
    };
  }

  return null;
};

export class AiProvider implements Provider<AiData> {
  readonly name = 'ai.provider';
  private readonly config: AiProviderConfig | null;
  private readonly cheapConfig: AiProviderConfig | null;
  private readonly codexConfig: AiProviderConfig | null;
  private readonly visionEnabled: boolean;
  private readonly logger?: Logger;

  constructor(
    private readonly options: ProviderRuntimeOptions,
    geminiKey?: string,
    geminiModel?: string,
    moonshotKey?: string,
    baseUrl?: string,
    model?: string,
    logger?: Logger,
    bigmodelKey?: string,
    bigmodelBaseUrl?: string,
    bigmodelModel?: string,
    codexKey?: string,
    codexBaseUrl?: string,
    codexModel?: string,
    visionEnabled = true,
    codexWireApi?: 'chat-completions' | 'responses',
  ) {
    this.config = resolveConfig(geminiKey, geminiModel, moonshotKey, baseUrl, model);
    this.cheapConfig = bigmodelKey
      ? { apiKey: bigmodelKey, baseUrl: bigmodelBaseUrl || 'https://open.bigmodel.cn/api/anthropic', model: bigmodelModel || 'glm-5', backend: 'anthropic' as AiBackend }
      : null;
    const codexBase = codexBaseUrl || 'https://right.codes/codex/v1';
    const codexBackend: AiBackend = codexWireApi === 'responses' || (!codexWireApi && codexBase.includes('gmn.chuangzuoli.com'))
      ? 'openai-responses'
      : 'openai';
    this.codexConfig = codexKey
      ? { apiKey: codexKey, baseUrl: codexBase, model: codexModel || 'gpt-5.2-high', backend: codexBackend }
      : null;
    this.visionEnabled = visionEnabled;
    this.logger = logger;
  }

  async run(ctx: CrawlContext) {
    const startedAt = Date.now();

    // Priority: codex (primary) > config (kimi/moonshot) > cheapConfig (bigmodel)
    const primaryConfig = this.codexConfig ?? this.config;
    const fallbackConfig = this.codexConfig ? (this.cheapConfig ?? this.config) : this.cheapConfig;
    const effectiveConfig = primaryConfig ?? fallbackConfig;

    try {
      if (!effectiveConfig) {
        return providerFailure(this.name, startedAt, 'AI_API_KEY_MISSING', 'No AI API key configured (set CODEX_API_KEY, MOONSHOT_API_KEY, GEMINI_API_KEY, or BIGMODEL_API_KEY)');
      }

      const hasScreenshot = this.visionEnabled && !!ctx.browser?.screenshotBuffer;
      const screenshotBuffer = hasScreenshot ? (ctx.browser!.screenshotBuffer as Buffer) : null;

      let text: string | null = null;
      let usedConfig: AiProviderConfig;

      if (primaryConfig && fallbackConfig) {
        // Both available: primary first, fallback on error
        usedConfig = primaryConfig;
        const prompt = this.buildPrompt(ctx, hasScreenshot);
        try {
          text = await this.callWithConfig(prompt, screenshotBuffer, usedConfig, 1);
        } catch (primaryErr) {
          this.logger?.warn({ module: 'ai', domain: ctx.domain, backend: usedConfig.backend, model: usedConfig.model, event: 'primary_failed', error: primaryErr instanceof Error ? primaryErr.message : 'unknown' });
          usedConfig = fallbackConfig;
          // Fallback is always text-only (BigModel doesn't support vision)
          text = await this.callWithConfig(prompt, null, usedConfig);
        }
      } else {
        // Only one provider available, use it directly
        usedConfig = effectiveConfig;
        const prompt = this.buildPrompt(ctx, hasScreenshot);
        text = await this.callWithConfig(prompt, screenshotBuffer, usedConfig);
      }

      if (!text) {
        this.logger?.warn({ module: 'ai', domain: ctx.domain, backend: usedConfig.backend, model: usedConfig.model, latency_ms: Date.now() - startedAt, event: 'empty_response' });
        throw new Error('AI_EMPTY_RESPONSE');
      }

      let jsonText = text.trim();
      const blockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (blockMatch?.[1]) {
        jsonText = blockMatch[1].trim();
      }

      const parsed = JSON.parse(jsonText) as Partial<AiData>;

      const normalized: AiData = {
        iabCategory: parsed.iabCategory ?? 'Uncategorized',
        iabSubCategory: parsed.iabSubCategory ?? 'General',
        confidence: clamp(typeof parsed.confidence === 'number' ? parsed.confidence : 0.5, 0, 1),
        tags: Array.isArray(parsed.tags) ? parsed.tags.filter((item): item is string => typeof item === 'string') : [],
        business: {
          summary: parsed.business?.summary ?? '',
          model: parsed.business?.model ?? 'Unknown',
          targetAudience: parsed.business?.targetAudience ?? '',
        },
        risk: {
          sentiment: parsed.risk?.sentiment === 'Spammy' ? 'Spammy' : 'Professional',
          score: clamp(typeof parsed.risk?.score === 'number' ? parsed.risk.score : 0, 0, 100),
          isSpam: parsed.risk?.isSpam ?? false,
        },
        ...(parsed.visualAnalysis ? {
          visualAnalysis: {
            designStyle: parsed.visualAnalysis.designStyle ?? 'Unknown',
            uiScore: clamp(typeof parsed.visualAnalysis.uiScore === 'number' ? parsed.visualAnalysis.uiScore : 5, 1, 10),
            vibe: parsed.visualAnalysis.vibe ?? 'Neutral',
            logoText: parsed.visualAnalysis.logoText ?? undefined,
          },
        } : {}),
      };

      this.logger?.info({ module: 'ai', domain: ctx.domain, backend: usedConfig.backend, model: usedConfig.model, latency_ms: Date.now() - startedAt, event: 'ok', category: normalized.iabCategory, confidence: normalized.confidence, hasVision: hasScreenshot });
      return providerSuccess(this.name, startedAt, normalized);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'AI provider failed';
      this.logger?.warn({ module: 'ai', domain: ctx.domain, backend: effectiveConfig?.backend, model: effectiveConfig?.model, latency_ms: Date.now() - startedAt, event: 'failed', error: errMsg });
      return providerFailure(this.name, startedAt, 'AI_PROVIDER_FAILED', errMsg);
    }
  }

  private async callWithConfig(prompt: string, screenshotBuffer: Buffer | null, cfg: AiProviderConfig, retryOverride?: number): Promise<string | null> {
    if (cfg.backend === 'gemini') return this.callGemini(prompt, cfg, retryOverride);
    if (cfg.backend === 'anthropic') return this.callAnthropic(prompt, screenshotBuffer, cfg, retryOverride);
    if (cfg.backend === 'openai-responses') return this.callOpenAIResponses(prompt, screenshotBuffer, cfg, retryOverride);
    return this.callOpenAI(prompt, screenshotBuffer, cfg, retryOverride);
  }

  private buildPrompt(ctx: CrawlContext, hasScreenshot = false): string {
    const contextParts: string[] = [
      `Domain: ${ctx.domain}`,
      `URL: ${ctx.url}`,
    ];

    if (ctx.htmlSignals) {
      contextParts.push(`Title: ${ctx.htmlSignals.title}`);
      contextParts.push(`Description: ${ctx.htmlSignals.description}`);
      contextParts.push(`Tech Stack: ${ctx.htmlSignals.techStackDetected.join(', ')}`);
      contextParts.push(`H1 Count: ${ctx.htmlSignals.h1Count}, H2 Count: ${ctx.htmlSignals.h2Count}`);
      contextParts.push(`Links: ${ctx.htmlSignals.internalLinks} internal, ${ctx.htmlSignals.externalLinks} external`);
    }

    const visionFields = hasScreenshot
      ? [
          '  "visualAnalysis": {',
          '    "designStyle": "e.g., Minimalist, Corporate, Playful, Brutalist, Editorial",',
          '    "uiScore": 1-10 (overall UI quality),',
          '    "vibe": "e.g., Trustworthy, Innovative, Fun, Professional, Edgy",',
          '    "logoText": "text visible in the logo, or null if not readable"',
          '  },',
        ]
      : [];

    const screenshotNote = hasScreenshot
      ? 'Analyze this website screenshot and text metadata below.'
      : 'Analyze this website based on the text metadata below.';

    return [
      `${screenshotNote} Return strict JSON with the following structure:`,
      '{',
      '  "iabCategory": "IAB category (e.g., Technology & Computing)",',
      '  "iabSubCategory": "IAB sub-category (e.g., Software)",',
      '  "confidence": 0.0-1.0,',
      '  "tags": ["tag1", "tag2"],',
      '  "business": {',
      '    "summary": "Brief business description",',
      '    "model": "Business model (e.g., SaaS, E-commerce, Media)",',
      '    "targetAudience": "Target audience description"',
      '  },',
      '  "risk": {',
      '    "sentiment": "Professional" or "Spammy",',
      '    "score": 0-100 (higher = riskier),',
      '    "isSpam": true/false',
      '  },',
      ...visionFields,
      '}',
      '',
      'Website Context:',
      ...contextParts,
    ].join('\n');
  }

  private async callGemini(prompt: string, cfg: AiProviderConfig, retryOverride?: number): Promise<string | null> {
    const response = await fetchWithRetry(
      `${cfg.baseUrl}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`,
      {
        timeoutMs: this.options.timeoutMs ?? 25000,
        retryAttempts: retryOverride ?? Math.max(this.options.retryAttempts ?? 2, 3),
        retryBaseMs: Math.max(this.options.retryBaseMs ?? 250, 1000),
        requestInit: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
          }),
        },
      },
    );

    const payload = await response.json() as {
      error?: { message?: string; code?: number };
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    if (payload.error?.message) {
      throw new Error(`GEMINI_ERROR_${payload.error.code ?? 'UNKNOWN'}: ${payload.error.message}`);
    }

    return payload.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  }

  private async callOpenAI(prompt: string, screenshotBuffer: Buffer | null, cfg: AiProviderConfig, retryOverride?: number): Promise<string | null> {
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';

    const content: Array<Record<string, unknown>> = [];
    if (screenshotBuffer) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/webp;base64,${screenshotBuffer.toString('base64')}` },
      });
    }
    content.push({ type: 'text', text: prompt });

    const messages = screenshotBuffer
      ? [{ role: 'user', content }]
      : [{ role: 'user', content: prompt }];

    const response = await fetchWithRetry(url, {
      timeoutMs: this.options.timeoutMs ?? 25000,
      retryAttempts: retryOverride ?? Math.max(this.options.retryAttempts ?? 2, 3),
      retryBaseMs: Math.max(this.options.retryBaseMs ?? 250, 1000),
      requestInit: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: 0.2,
          ...(screenshotBuffer ? {} : { response_format: { type: 'json_object' } }),
        }),
      },
    });

    const payload = await response.json() as {
      error?: { message?: string; type?: string };
      choices?: Array<{ message?: { content?: string } }>;
    };

    if (payload.error?.message) {
      throw new Error(`OPENAI_${(payload.error.type ?? 'API_ERROR').toUpperCase()}: ${payload.error.message}`);
    }

    return payload.choices?.[0]?.message?.content ?? null;
  }

  private async callOpenAIResponses(prompt: string, screenshotBuffer: Buffer | null, cfg: AiProviderConfig, retryOverride?: number): Promise<string | null> {
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/responses';

    const inputContent: Array<Record<string, unknown>> = [];
    if (screenshotBuffer) {
      inputContent.push({
        type: 'input_image',
        image_url: `data:image/webp;base64,${screenshotBuffer.toString('base64')}`,
      });
    }
    inputContent.push({ type: 'input_text', text: prompt });

    const response = await fetchWithRetry(url, {
      timeoutMs: this.options.timeoutMs ?? 25000,
      retryAttempts: retryOverride ?? Math.max(this.options.retryAttempts ?? 2, 3),
      retryBaseMs: Math.max(this.options.retryBaseMs ?? 250, 1000),
      requestInit: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          input: [{ role: 'user', content: inputContent }],
          temperature: 0.2,
        }),
      },
    });

    const payload = await response.json() as {
      error?: { message?: string; type?: string };
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    };

    if (payload.error?.message) {
      throw new Error(`OPENAI_${(payload.error.type ?? 'API_ERROR').toUpperCase()}: ${payload.error.message}`);
    }

    // Responses API: output[].content[].text
    for (const item of payload.output ?? []) {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' && part.text) return part.text;
      }
    }
    return null;
  }

  private async callAnthropic(prompt: string, screenshotBuffer: Buffer | null, cfg: AiProviderConfig, retryOverride?: number): Promise<string | null> {
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/v1/messages';

    const contentParts: Array<Record<string, unknown>> = [];

    if (screenshotBuffer) {
      contentParts.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/webp',
          data: screenshotBuffer.toString('base64'),
        },
      });
    }

    contentParts.push({ type: 'text', text: prompt });

    const response = await fetchWithRetry(url, {
      timeoutMs: this.options.timeoutMs ?? 25000,
      retryAttempts: retryOverride ?? Math.max(this.options.retryAttempts ?? 2, 3),
      retryBaseMs: Math.max(this.options.retryBaseMs ?? 250, 1000),
      requestInit: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 4096,
          messages: [{ role: 'user', content: contentParts }],
        }),
      },
    });

    const payload = await response.json() as {
      type?: string;
      error?: { type?: string; code?: string; message?: string };
      content?: Array<{ text?: string }>;
    };

    if ((payload.type === 'error' && payload.error?.message) || payload.error?.message) {
      throw new Error(`ANTHROPIC_${(payload.error.type ?? payload.error.code ?? 'API_ERROR').toString().toUpperCase()}: ${payload.error.message}`);
    }

    return payload.content?.[0]?.text ?? null;
  }

}
