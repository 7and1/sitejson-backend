import { promises as dns } from 'node:dns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const undiciMock = vi.hoisted(() => {
  const agentInstances: Array<{
    options: Record<string, unknown>;
    close: ReturnType<typeof vi.fn>;
  }> = [];

  return {
    agentInstances,
    fetch: vi.fn(),
    Agent: vi.fn((options?: Record<string, unknown>) => {
      const agent = {
        options: options ?? {},
        close: vi.fn().mockResolvedValue(undefined),
      };
      agentInstances.push(agent);
      return agent;
    }),
    ProxyAgent: vi.fn((proxyUrl: string) => ({
      proxyUrl,
      close: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

vi.mock('undici', () => ({
  Agent: undiciMock.Agent,
  ProxyAgent: undiciMock.ProxyAgent,
  fetch: undiciMock.fetch,
}));

import {
  computeRotationBackoffMs,
  fetchDirectWithSafeRedirects,
  fetchHtmlWithFallbackChain,
  fetchWithProxyRotation,
  fetchWithRetry,
  getRandomProxies,
  parseRetryAfterMs,
  selectUniqueIpProxies,
} from '../http.js';

vi.mock('node:dns', () => ({
  promises: {
    resolve4: vi.fn(),
    resolve6: vi.fn(),
  },
}));

const mockPublicDns = () => {
  vi.mocked(dns.resolve4).mockResolvedValue(['93.184.216.34']);
  vi.mocked(dns.resolve6).mockResolvedValue([]);
};

const testProxy = (host: string, port: number) => ({
  host,
  port,
  username: `user-${port}`,
  password: `pass-${port}`,
});

beforeEach(() => {
  mockPublicDns();
  undiciMock.fetch.mockReset();
  undiciMock.Agent.mockClear();
  undiciMock.ProxyAgent.mockClear();
  undiciMock.agentInstances.length = 0;
});

describe('proxy selection helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses Fisher-Yates shuffle for random proxy sampling without mutating input', () => {
    const randomValues = [0.1, 0.8, 0.2];
    vi.spyOn(Math, 'random').mockImplementation(() => randomValues.shift() ?? 0);
    const proxies = [
      testProxy('10.0.0.1', 8001),
      testProxy('10.0.0.2', 8002),
      testProxy('10.0.0.3', 8003),
      testProxy('10.0.0.4', 8004),
    ];

    const selected = getRandomProxies(proxies, 3);

    expect(selected.map((proxy) => proxy.port)).toEqual([8002, 8004, 8003]);
    expect(proxies.map((proxy) => proxy.port)).toEqual([8001, 8002, 8003, 8004]);
  });

  it('keeps one proxy per host after unbiased shuffle', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const proxies = [
      testProxy('10.0.0.1', 8001),
      testProxy('10.0.0.1', 8002),
      testProxy('10.0.0.2', 8003),
      testProxy('10.0.0.3', 8004),
    ];

    const selected = selectUniqueIpProxies(proxies, 3);

    expect(selected.map((proxy) => `${proxy.host}:${proxy.port}`)).toEqual([
      '10.0.0.1:8002',
      '10.0.0.2:8003',
      '10.0.0.3:8004',
    ]);
    expect(new Set(selected.map((proxy) => proxy.host)).size).toBe(selected.length);
  });
});

describe('fetchWithProxyRotation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to direct fetch when proxy pools are empty', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    const response = await fetchWithProxyRotation('https://example.com', {
      timeoutMs: 100,
      retryBaseMs: 1,
      primaryProxies: [],
      fallbackProxies: [],
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('throws HTTP status when direct fetch fallback is not ok', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('upstream error', { status: 503 }),
    );

    await expect(fetchWithProxyRotation('https://example.com', {
      timeoutMs: 100,
      retryBaseMs: 1,
      primaryProxies: [],
      fallbackProxies: [],
    })).rejects.toThrow('HTTP_503');
  });

  it('does not retry direct non-429 4xx responses', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not found', { status: 404 }),
    );

    await expect(fetchWithRetry('https://example.com/missing', {
      timeoutMs: 100,
      retryAttempts: 3,
      retryBaseMs: 1,
    })).rejects.toThrow('HTTP_404');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not rotate to direct fallback on non-429 4xx responses', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('forbidden', { status: 403 }),
    );

    await expect(fetchWithProxyRotation('https://example.com/blocked', {
      timeoutMs: 100,
      retryBaseMs: 1,
      primaryProxies: [],
      fallbackProxies: [],
    })).rejects.toThrow('HTTP_403');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('tries direct fetch once after all proxies fail', async () => {
    undiciMock.fetch.mockRejectedValue(new Error('proxy failed'));
    const directFetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    const response = await fetchWithProxyRotation('https://example.com', {
      timeoutMs: 100,
      retryBaseMs: 1,
      primaryProxies: [
        { host: '127.0.0.1', port: 1, username: 'u', password: 'p' },
      ],
      fallbackProxies: [
        { host: '127.0.0.1', port: 2, username: 'u2', password: 'p2' },
      ],
    });

    expect(response.status).toBe(200);
    expect(undiciMock.fetch).toHaveBeenCalledTimes(2);
    expect(directFetchSpy).toHaveBeenCalledOnce();
  });
});

describe('retry helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses Retry-After seconds and HTTP-date', () => {
    expect(parseRetryAfterMs('5', 0)).toBe(5000);

    const now = Date.parse('Wed, 21 Oct 2015 07:27:00 GMT');
    expect(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', now)).toBe(60000);
  });

  it('returns null for invalid Retry-After values', () => {
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs('not-a-date')).toBeNull();
  });

  it('computes capped exponential backoff with retry-after override', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(computeRotationBackoffMs({
      retryBaseMs: 500,
      attempt: 2,
      isFallback: false,
    })).toBe(1000);

    expect(computeRotationBackoffMs({
      retryBaseMs: 500,
      attempt: 2,
      isFallback: true,
    })).toBe(2000);

    expect(computeRotationBackoffMs({
      retryBaseMs: 500,
      attempt: 1,
      isFallback: false,
      retryAfterMs: 4000,
    })).toBe(4000);

    expect(computeRotationBackoffMs({
      retryBaseMs: 500,
      attempt: 1,
      isFallback: false,
      retryAfterMs: 120000,
    })).toBe(60000);
  });
});

describe('fetchHtmlWithFallbackChain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns direct html when available', async () => {
    undiciMock.fetch.mockResolvedValue(
      new Response('<html><body>ok</body></html>', { status: 200 }),
    );

    const result = await fetchHtmlWithFallbackChain('https://example.com', {
      timeoutMs: 100,
      retryAttempts: 0,
      retryBaseMs: 1,
      userAgent: 'Test/1.0',
    });

    expect(result?.source).toBe('direct');
    expect(result?.trace[0]?.source).toBe('direct');
    expect(result?.trace[0]?.ok).toBe(true);
    expect(undiciMock.fetch).toHaveBeenCalledOnce();
  });

  it('blocks direct fetch to private IP literals before request', async () => {
    const result = await fetchHtmlWithFallbackChain('http://127.0.0.1/admin', {
      timeoutMs: 100,
      retryAttempts: 0,
      retryBaseMs: 1,
      userAgent: 'Test/1.0',
    });

    expect(result).toBeNull();
    expect(undiciMock.fetch).not.toHaveBeenCalled();
  });

  it('blocks redirects to private IP literals before following them', async () => {
    undiciMock.fetch.mockResolvedValueOnce(
      new Response('', {
        status: 302,
        headers: {
          location: 'http://127.0.0.1/admin',
        },
      }),
    );

    const result = await fetchHtmlWithFallbackChain('https://example.com', {
      timeoutMs: 100,
      retryAttempts: 0,
      retryBaseMs: 1,
      userAgent: 'Test/1.0',
    });

    expect(result).toBeNull();
    expect(undiciMock.fetch).toHaveBeenCalledTimes(1);
  });

  it('pins direct fetch DNS lookup to the prevalidated public addresses', async () => {
    undiciMock.fetch.mockResolvedValue(
      new Response('<html><body>ok</body></html>', { status: 200 }),
    );

    const response = await fetchDirectWithSafeRedirects('https://example.com', {
      timeoutMs: 100,
      retryAttempts: 0,
      retryBaseMs: 1,
    });
    await response.text();

    const agentOptions = undiciMock.agentInstances[0]?.options as {
      connect?: {
        lookup?: (
          hostname: string,
          options: { all?: boolean },
          callback: (error: Error | null, address: unknown, family?: number) => void,
        ) => void;
      };
    };
    const lookup = agentOptions.connect?.lookup;
    expect(lookup).toBeTypeOf('function');

    const allResult = await new Promise<{ error: Error | null; address: unknown; family?: number }>((resolve) => {
      lookup?.('example.com', { all: true }, (error, address, family) => resolve({ error, address, family }));
    });
    expect(allResult.error).toBeNull();
    expect(allResult.address).toEqual([{ address: '93.184.216.34', family: 4 }]);

    const mismatchResult = await new Promise<{ error: Error | null; address: unknown; family?: number }>((resolve) => {
      lookup?.('internal.example', { all: true }, (error, address, family) => resolve({ error, address, family }));
    });
    expect(mismatchResult.error?.message).toContain('SSRF_HOSTNAME_MISMATCH');
    expect(undiciMock.agentInstances[0]?.close).toHaveBeenCalledOnce();
  });

  it('closes the pinned dispatcher when direct fetch fails', async () => {
    undiciMock.fetch.mockRejectedValue(new Error('socket failed'));

    await expect(fetchDirectWithSafeRedirects('https://example.com', {
      timeoutMs: 100,
      retryAttempts: 0,
      retryBaseMs: 1,
    })).rejects.toThrow('socket failed');

    expect(undiciMock.agentInstances[0]?.close).toHaveBeenCalledOnce();
  });
});
