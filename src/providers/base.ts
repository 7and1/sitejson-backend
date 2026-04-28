import type { CrawlContext, ProviderResult } from '../core/types.js';

export interface Provider<T = unknown> {
  name: string;
  run(ctx: CrawlContext): Promise<ProviderResult<T | null>>;
}

export const providerSuccess = <T>(provider: string, startedAt: number, data: T): ProviderResult<T> => {
  return {
    provider,
    ok: true,
    latencyMs: Math.max(0, Date.now() - startedAt),
    data,
  };
};

export const providerFailure = (
  provider: string,
  startedAt: number,
  code: string,
  message: string,
): ProviderResult<null> => {
  return {
    provider,
    ok: false,
    latencyMs: Math.max(0, Date.now() - startedAt),
    data: null,
    error: {
      code,
      message,
    },
  };
};
