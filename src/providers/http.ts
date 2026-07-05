import { setTimeout as sleep } from 'node:timers/promises';
import type { LookupFunction } from 'node:net';
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';
import type { Dispatcher } from 'undici';
import { resolvePublicAddresses } from '../services/network-safety.js';
import { shuffleArray } from './anti-bot.js';

export interface ProxyConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface ProxyPools {
  primary: ProxyConfig[];
  fallback: ProxyConfig[];
}

export interface ProxyGridFallbackOptions {
  baseUrl?: string;
  secret?: string;
  timeoutMs: number;
  retryAttempts: number;
  retryBaseMs: number;
}

export interface SoaxFallbackOptions {
  apiUrl?: string;
  secret?: string;
  timeoutMs: number;
  retryAttempts: number;
  retryBaseMs: number;
  country?: string;
  proxyType?: number;
}

export interface FlareSolverrFallbackOptions {
  baseUrl?: string;
  timeoutMs: number;
  retryAttempts: number;
  retryBaseMs: number;
  maxTimeoutMs?: number;
  session?: string;
}

export interface FetchTrace {
  lane: 'browser' | 'traffic';
  source: 'rotation' | 'direct' | 'proxy_grid' | 'soax' | 'flaresolverr';
  ok: boolean;
  latencyMs: number;
  errorCode?: string;
}

const normalizeErrorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (!message) {
    return 'UNKNOWN_ERROR';
  }

  const upper = message.toUpperCase();
  if (upper.startsWith('HTTP_')) {
    return upper;
  }
  if (upper.includes('ABORT') || upper.includes('TIMEOUT')) {
    return 'TIMEOUT';
  }
  if (upper.includes('ECONN') || upper.includes('ENOTFOUND') || upper.includes('EAI_AGAIN')) {
    return 'NETWORK_ERROR';
  }

  return upper.replace(/[^A-Z0-9_]+/g, '_').slice(0, 64) || 'UNKNOWN_ERROR';
};

const MAX_RETRY_AFTER_MS = 120_000;
const MAX_ROTATION_BACKOFF_MS = 60_000;
const MAX_SAFE_REDIRECTS = 5;

type ResolvedDirectUrl = {
  parsed: URL;
  addresses: string[];
};

class NonRetryableHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP_${status}`);
    this.name = 'NonRetryableHttpError';
  }
}

const isNonRetryableHttpStatus = (status: number): boolean => (
  status >= 400 && status < 500 && status !== 429
);

const createDeadlineSignal = (timeoutMs: number, existingSignal?: AbortSignal | null): AbortSignal => {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.trunc(timeoutMs)));
  if (!existingSignal) {
    return timeoutSignal;
  }

  return AbortSignal.any([existingSignal, timeoutSignal]);
};

export const parseRetryAfterMs = (value: string | null | undefined, nowMs = Date.now()): number | null => {
  if (!value) return null;

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const seconds = Number.parseInt(trimmed, 10);
  if (Number.isFinite(seconds)) {
    if (seconds <= 0) return 0;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const retryDateMs = Date.parse(trimmed);
  if (!Number.isFinite(retryDateMs)) {
    return null;
  }

  const delta = retryDateMs - nowMs;
  if (delta <= 0) return 0;
  return Math.min(delta, MAX_RETRY_AFTER_MS);
};

const computeBackoffWithJitterMs = (
  retryBaseMs: number,
  attempt: number,
  maxMs: number,
): number => {
  const exponential = Math.max(1, retryBaseMs) * 2 ** Math.max(0, attempt - 1);
  const bounded = Math.min(exponential, maxMs);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(bounded * 0.2)));
  return Math.min(maxMs, bounded + jitter);
};

export const computeRotationBackoffMs = (input: {
  retryBaseMs: number;
  attempt: number;
  isFallback: boolean;
  retryAfterMs?: number | null;
}): number => {
  const base = input.isFallback ? input.retryBaseMs * 2 : input.retryBaseMs;
  const expBackoffMs = computeBackoffWithJitterMs(base, input.attempt, MAX_ROTATION_BACKOFF_MS);
  const retryAfterMs = input.retryAfterMs ?? null;

  if (retryAfterMs === null) {
    return expBackoffMs;
  }

  return Math.min(MAX_ROTATION_BACKOFF_MS, Math.max(expBackoffMs, retryAfterMs));
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === 'object' && !Array.isArray(value);
};

const extractTextFromUnknown = (value: unknown, depth = 0): string | null => {
  if (depth > 5 || value == null) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractTextFromUnknown(item, depth + 1);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const preferredKeys = [
    'html',
    'content',
    'body',
    'text',
    'markdown',
    'result',
    'response',
    'data',
    'payload',
  ];

  for (const key of preferredKeys) {
    const found = extractTextFromUnknown(value[key], depth + 1);
    if (found) {
      return found;
    }
  }

  for (const nested of Object.values(value)) {
    const found = extractTextFromUnknown(nested, depth + 1);
    if (found) {
      return found;
    }
  }

  return null;
};

/** Read response body as text, capped at maxBytes to prevent unbounded memory usage */
const readBoundedText = async (response: Response, maxBytes = 2 * 1024 * 1024): Promise<string> => {
  const contentLength = parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error('RESPONSE_TOO_LARGE');
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return response.text();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(merged);
};

const extractBodyText = async (response: Response): Promise<string | null> => {
  const raw = await readBoundedText(response);
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<HTML')) {
    return trimmed;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return extractTextFromUnknown(parsed) ?? trimmed;
  } catch {
    return trimmed;
  }
};

/**
 * Parse proxy list from env format
 * Supports multiple formats:
 * - Pipe-comma: "ip:port,user,pass|..."
 * - Colon-only: "ip:port:user:pass|..."
 * - URL style: "user:pass@host:port|..." (soax, apify)
 * - Auto format: "auto:user@host:port" (apify)
 */
export const parseProxyList = (proxyList: string): ProxyConfig[] => {
  return proxyList.split('|').map((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('auto:')) {
      const rest = trimmed.slice(5);
      const atIdx = rest.indexOf('@');
      if (atIdx > 0) {
        const userPass = rest.slice(0, atIdx);
        const hostPort = rest.slice(atIdx + 1);
        const [host, portStr] = hostPort.split(':');
        return { host, port: parseInt(portStr, 10), username: userPass, password: '' };
      }
    }

    if (trimmed.includes('@')) {
      const atIdx = trimmed.lastIndexOf('@');
      const userPass = trimmed.slice(0, atIdx);
      const hostPort = trimmed.slice(atIdx + 1);
      const [host, portStr] = hostPort.split(':');
      const colonIdx = userPass.indexOf(':');
      if (colonIdx > 0) {
        const username = userPass.slice(0, colonIdx);
        const password = userPass.slice(colonIdx + 1);
        return { host, port: parseInt(portStr, 10), username, password };
      }
      return { host, port: parseInt(portStr, 10), username: userPass, password: '' };
    }

    if (trimmed.includes(',')) {
      const [hostPort, username, password] = trimmed.split(',');
      const [host, portStr] = hostPort.split(':');
      return { host, port: parseInt(portStr, 10), username, password };
    }

    const parts = trimmed.split(':');
    if (parts.length >= 4) {
      const [host, portStr, username, password] = parts;
      return { host, port: parseInt(portStr, 10), username, password };
    }

    return null;
  }).filter((p): p is ProxyConfig => p !== null && !!p.host && !!p.port && !!p.username);
};

export const getRandomProxy = (proxies: ProxyConfig[], exclude?: Set<string>): ProxyConfig | null => {
  if (proxies.length === 0) return null;

  const available = exclude
    ? proxies.filter((proxy) => !exclude.has(`${proxy.host}:${proxy.port}`))
    : proxies;

  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
};

export const getRandomProxies = (proxies: ProxyConfig[], count: number): ProxyConfig[] => {
  const shuffled = [...proxies];
  shuffleArray(shuffled);
  return shuffled.slice(0, Math.min(count, shuffled.length));
};

const withTimeout = async (
  url: string,
  timeoutMs: number,
  init?: RequestInit,
  proxy?: ProxyConfig,
  dispatcher?: Dispatcher,
) => {
  const signal = createDeadlineSignal(timeoutMs, init?.signal);

  if (proxy) {
    const proxyUrl = `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
    const agent = new ProxyAgent(proxyUrl);
    return await undiciFetch(url, {
      ...init,
      signal,
      dispatcher: agent,
    } as Parameters<typeof undiciFetch>[1]);
  }

  if (dispatcher) {
    return await undiciFetch(url, {
      ...init,
      signal,
      dispatcher,
    } as Parameters<typeof undiciFetch>[1]);
  }

  return await fetch(url, {
    ...init,
    signal,
  });
};

export const fetchWithRetry = async (
  url: string,
  options: {
    allowManualRedirect?: boolean;
    timeoutMs: number;
    retryAttempts: number;
    retryBaseMs: number;
    requestInit?: RequestInit;
    proxy?: ProxyConfig;
    dispatcher?: Dispatcher;
  },
): Promise<Response> => {
  const maxAttempts = options.retryAttempts + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await withTimeout(
        url,
        options.timeoutMs,
        options.requestInit,
        options.proxy,
        options.dispatcher,
      );
      const isManualRedirect = !!options.allowManualRedirect
        && response.status >= 300
        && response.status < 400
        && response.headers.has('location');
      if (isManualRedirect) {
        return response as Response;
      }
      if (isNonRetryableHttpStatus(response.status)) {
        throw new NonRetryableHttpError(response.status);
      }
      const isRetryable = response.status === 429 || response.status >= 500;
      if (!response.ok && isRetryable && attempt < maxAttempts) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after')) ?? 0;
        const baseBackoffMs = options.retryBaseMs * 2 ** (attempt - 1);
        const backoffMs = Math.min(MAX_RETRY_AFTER_MS, Math.max(baseBackoffMs, retryAfterMs));
        await sleep(backoffMs);
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP_${response.status}`);
      }

      return response as Response;
    } catch (error) {
      lastError = error;
      if (error instanceof NonRetryableHttpError) {
        throw error;
      }
      if (attempt < maxAttempts) {
        const backoffMs = options.retryBaseMs * 2 ** (attempt - 1);
        await sleep(backoffMs);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('FETCH_FAILED');
};

const getAddressFamily = (address: string): 4 | 6 => {
  return address.includes(':') ? 6 : 4;
};

const createLookupMismatchError = (requested: string, expected: string): NodeJS.ErrnoException => {
  const error = new Error(`SSRF_HOSTNAME_MISMATCH:${requested}:${expected}`) as NodeJS.ErrnoException;
  error.code = 'SSRF_HOSTNAME_MISMATCH';
  return error;
};

const createPinnedLookup = (hostname: string, addresses: string[]): LookupFunction => {
  const expectedHostname = hostname.toLowerCase();
  const pinnedAddresses = addresses.map((address) => ({
    address,
    family: getAddressFamily(address),
  }));

  return (requestedHostname, lookupOptions, callback) => {
    if (requestedHostname.toLowerCase() !== expectedHostname) {
      callback(createLookupMismatchError(requestedHostname, expectedHostname), '', 0);
      return;
    }

    if (lookupOptions.all) {
      callback(null, pinnedAddresses);
      return;
    }

    const first = pinnedAddresses[0];
    callback(null, first.address, first.family);
  };
};

const createPinnedDispatcher = (hostname: string, addresses: string[]): Dispatcher => {
  return new Agent({
    connect: {
      lookup: createPinnedLookup(hostname, addresses),
    },
  });
};

const closeDispatcher = (dispatcher: Dispatcher): void => {
  void dispatcher.close().catch(() => undefined);
};

const responseWithDispatcherCleanup = (response: Response, dispatcher: Dispatcher): Response => {
  if (!response.body) {
    closeDispatcher(dispatcher);
    return response;
  }

  const reader = response.body.getReader();
  let closed = false;
  const closeOnce = () => {
    if (closed) {
      return;
    }
    closed = true;
    closeDispatcher(dispatcher);
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          closeOnce();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        closeOnce();
        controller.error(error);
      }
    },
    async cancel(reason) {
      closeOnce();
      await reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const assertSafeDirectUrl = async (rawUrl: string): Promise<ResolvedDirectUrl> => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('SSRF_INVALID_URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('SSRF_BLOCKED_SCHEME');
  }

  if (parsed.username || parsed.password) {
    throw new Error('SSRF_BLOCKED_CREDENTIALS');
  }

  const addresses = await resolvePublicAddresses(parsed.hostname);
  return { parsed, addresses };
};

export const fetchDirectWithSafeRedirects = async (
  url: string,
  options: {
    timeoutMs: number;
    retryAttempts: number;
    retryBaseMs: number;
    requestInit?: RequestInit;
  },
): Promise<Response> => {
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= MAX_SAFE_REDIRECTS; redirectCount += 1) {
    const { parsed: parsedUrl, addresses } = await assertSafeDirectUrl(currentUrl);
    const dispatcher = createPinnedDispatcher(parsedUrl.hostname, addresses);
    let response: Response;
    try {
      response = await fetchWithRetry(parsedUrl.toString(), {
        allowManualRedirect: true,
        timeoutMs: options.timeoutMs,
        retryAttempts: options.retryAttempts,
        retryBaseMs: options.retryBaseMs,
        dispatcher,
        requestInit: {
          ...options.requestInit,
          redirect: 'manual',
        },
      });
    } catch (error) {
      closeDispatcher(dispatcher);
      throw error;
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        closeDispatcher(dispatcher);
        throw new Error(`HTTP_${response.status}`);
      }

      closeDispatcher(dispatcher);
      currentUrl = new URL(location, parsedUrl).toString();
      continue;
    }

    return responseWithDispatcherCleanup(response as Response, dispatcher);
  }

  throw new Error('SSRF_TOO_MANY_REDIRECTS');
};

export const fetchWithProxyRotation = async (
  url: string,
  options: {
    timeoutMs: number;
    retryBaseMs: number;
    requestInit?: RequestInit | ((context: {
      attempt: number;
      isFallback: boolean;
      proxy?: ProxyConfig;
      isDirect: boolean;
    }) => RequestInit);
    primaryProxies: ProxyConfig[];
    fallbackProxies: ProxyConfig[];
    maxPrimaryProxies?: number;
  },
): Promise<Response> => {
  const {
    primaryProxies,
    fallbackProxies,
    timeoutMs,
    retryBaseMs,
    requestInit,
    maxPrimaryProxies,
  } = options;

  const uniqueIpProxies = selectUniqueIpProxies(primaryProxies, Math.max(1, Math.trunc(maxPrimaryProxies ?? 6)));
  const allProxies = [...uniqueIpProxies, ...fallbackProxies];
  const resolveRequestInit = (context: {
    attempt: number;
    isFallback: boolean;
    proxy?: ProxyConfig;
    isDirect: boolean;
  }): RequestInit | undefined => {
    if (!requestInit) return undefined;
    if (typeof requestInit === 'function') {
      return requestInit(context);
    }
    return requestInit;
  };

  if (allProxies.length === 0) {
    const response = await withTimeout(url, timeoutMs, resolveRequestInit({
      attempt: 1,
      isFallback: false,
      isDirect: true,
    }));
    if (!response.ok) {
      if (isNonRetryableHttpStatus(response.status)) {
        throw new NonRetryableHttpError(response.status);
      }
      throw new Error(`HTTP_${response.status}`);
    }
    return response as Response;
  }

  let lastError: unknown;

  for (let index = 0; index < allProxies.length; index += 1) {
    const proxy = allProxies[index];
    const isFallback = index >= uniqueIpProxies.length;
    const attempt = index + 1;

    try {
      const response = await withTimeout(
        url,
        timeoutMs,
        resolveRequestInit({
          attempt,
          isFallback,
          proxy,
          isDirect: false,
        }),
        proxy,
      );
      if (!response.ok) {
        const status = response.status;
        if (isNonRetryableHttpStatus(status)) {
          throw new NonRetryableHttpError(status);
        }
        const retryAfterMs = (status === 429 || status === 503)
          ? parseRetryAfterMs(response.headers.get('retry-after'))
          : null;

        if (index < allProxies.length - 1) {
          const backoffMs = computeRotationBackoffMs({
            retryBaseMs,
            attempt,
            isFallback,
            retryAfterMs,
          });
          await sleep(backoffMs);
          continue;
        }

        throw new Error(`HTTP_${status}`);
      }

      return response as Response;
    } catch (error) {
      lastError = error;
      if (error instanceof NonRetryableHttpError) {
        throw error;
      }

      if (index < allProxies.length - 1) {
        const backoffMs = computeRotationBackoffMs({
          retryBaseMs,
          attempt,
          isFallback,
          retryAfterMs: null,
        });
        await sleep(backoffMs);
      }
    }
  }

  try {
    const response = await withTimeout(url, timeoutMs, resolveRequestInit({
      attempt: allProxies.length + 1,
      isFallback: false,
      isDirect: true,
    }));
    if (!response.ok) {
      if (isNonRetryableHttpStatus(response.status)) {
        throw new NonRetryableHttpError(response.status);
      }
      throw new Error(`HTTP_${response.status}`);
    }
    return response as Response;
  } catch (error) {
    lastError = error;
  }

  throw lastError instanceof Error ? lastError : new Error('ALL_PROXIES_FAILED');
};

export const fetchTextViaProxyGrid = async (
  targetUrl: string,
  options: ProxyGridFallbackOptions,
): Promise<string | null> => {
  const baseUrl = options.baseUrl?.trim();
  const secret = options.secret?.trim();

  if (!baseUrl || !secret) {
    return null;
  }

  const headers = {
    'content-type': 'application/json',
    'x-grid-secret': secret,
  };

  try {
    const gridResponse = await fetchWithRetry(`${baseUrl.replace(/\/$/, '')}/api/grid`, {
      timeoutMs: options.timeoutMs,
      retryAttempts: options.retryAttempts,
      retryBaseMs: options.retryBaseMs,
      requestInit: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          target: targetUrl,
          force: false,
        }),
      },
    });

    const gridText = await extractBodyText(gridResponse);
    if (gridText) {
      return gridText;
    }
  } catch {
    // continue to search endpoint
  }

  try {
    const searchResponse = await fetchWithRetry(`${baseUrl.replace(/\/$/, '')}/api/search`, {
      timeoutMs: options.timeoutMs,
      retryAttempts: options.retryAttempts,
      retryBaseMs: options.retryBaseMs,
      requestInit: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'web2md',
          url: targetUrl,
        }),
      },
    });

    return await extractBodyText(searchResponse);
  } catch {
    return null;
  }
};

export const fetchTextViaSoax = async (
  targetUrl: string,
  options: SoaxFallbackOptions,
): Promise<string | null> => {
  const apiUrl = options.apiUrl?.trim();
  const secret = options.secret?.trim();

  if (!apiUrl || !secret) {
    return null;
  }

  try {
    const response = await fetchWithRetry(apiUrl, {
      timeoutMs: options.timeoutMs,
      retryAttempts: options.retryAttempts,
      retryBaseMs: options.retryBaseMs,
      requestInit: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-soax-api-secret': secret,
        },
        body: JSON.stringify({
          url: targetUrl,
          proxy_settings: {
            country: options.country ?? 'us',
            type: options.proxyType ?? 1,
          },
          response: {
            markdown: false,
          },
        }),
      },
    });

    return await extractBodyText(response);
  } catch {
    return null;
  }
};

export const fetchTextViaFlareSolverr = async (
  targetUrl: string,
  options: FlareSolverrFallbackOptions,
): Promise<string | null> => {
  const baseUrl = options.baseUrl?.trim();
  if (!baseUrl) {
    return null;
  }

  const endpoint = `${baseUrl.replace(/\/$/, '')}/v1`;
  const response = await fetchWithRetry(endpoint, {
    timeoutMs: options.timeoutMs,
    retryAttempts: options.retryAttempts,
    retryBaseMs: options.retryBaseMs,
    requestInit: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        cmd: 'request.get',
        url: targetUrl,
        maxTimeout: options.maxTimeoutMs ?? options.timeoutMs,
        session: options.session,
      }),
    },
  });

  const payload = await response.json() as {
    status?: string;
    message?: string;
    solution?: {
      status?: number;
      response?: string;
    };
  };

  if (payload.status !== 'ok') {
    return null;
  }

  const html = payload.solution?.response;
  if (typeof html !== 'string' || html.trim().length === 0) {
    return null;
  }

  return html;
};

const fetchViaDirect = async (
  url: string,
  options: {
    timeoutMs: number;
    retryAttempts: number;
    retryBaseMs: number;
    userAgent: string;
  },
): Promise<string> => {
  const response = await fetchDirectWithSafeRedirects(url, {
    timeoutMs: options.timeoutMs,
    retryAttempts: options.retryAttempts,
    retryBaseMs: options.retryBaseMs,
    requestInit: {
      headers: {
        'user-agent': options.userAgent,
        accept: 'text/html,application/xhtml+xml',
      },
    },
  });

  return readBoundedText(response);
};

export const fetchHtmlWithFallbackChain = async (
  url: string,
  options: {
    timeoutMs: number;
    retryAttempts: number;
    retryBaseMs: number;
    userAgent: string;
    proxyGrid?: ProxyGridFallbackOptions;
    soax?: SoaxFallbackOptions;
    logger?: { info: (obj: Record<string, unknown>) => void };
    domain?: string;
  },
): Promise<{ html: string; source: 'direct' | 'proxy_grid' | 'soax'; trace: FetchTrace[] } | null> => {
  const trace: FetchTrace[] = [];
  const log = options.logger;
  const domain = options.domain;

  const directStartedAt = Date.now();
  try {
    const html = await fetchViaDirect(url, options);
    if (html.trim().length > 0) {
      trace.push({
        lane: 'browser',
        source: 'direct',
        ok: true,
        latencyMs: Date.now() - directStartedAt,
      });
      return {
        html,
        source: 'direct',
        trace,
      };
    }

    trace.push({
      lane: 'browser',
      source: 'direct',
      ok: false,
      latencyMs: Date.now() - directStartedAt,
      errorCode: 'EMPTY_BODY',
    });
  } catch (error) {
    trace.push({
      lane: 'browser',
      source: 'direct',
      ok: false,
      latencyMs: Date.now() - directStartedAt,
      errorCode: normalizeErrorCode(error),
    });
  }

  const gridStartedAt = Date.now();
  try {
    const proxyGridHtml = options.proxyGrid
      ? await fetchTextViaProxyGrid(url, options.proxyGrid)
      : null;

    const gridOk = !!(proxyGridHtml && proxyGridHtml.trim().length > 0);
    const gridLatency = Date.now() - gridStartedAt;
    log?.info({ domain, module: 'http', event: 'proxy_grid_html', ok: gridOk, latencyMs: gridLatency });

    if (gridOk) {
      trace.push({ lane: 'browser', source: 'proxy_grid', ok: true, latencyMs: gridLatency });
      return { html: proxyGridHtml!, source: 'proxy_grid', trace };
    }

    trace.push({
      lane: 'browser',
      source: 'proxy_grid',
      ok: false,
      latencyMs: gridLatency,
      errorCode: options.proxyGrid ? 'EMPTY_BODY' : 'NOT_CONFIGURED',
    });
  } catch (error) {
    const gridLatency = Date.now() - gridStartedAt;
    const errorCode = normalizeErrorCode(error);
    log?.info({ domain, module: 'http', event: 'proxy_grid_html', ok: false, latencyMs: gridLatency, errorCode });
    trace.push({ lane: 'browser', source: 'proxy_grid', ok: false, latencyMs: gridLatency, errorCode });
  }

  const soaxStartedAt = Date.now();
  try {
    const soaxHtml = options.soax
      ? await fetchTextViaSoax(url, options.soax)
      : null;

    const soaxOk = !!(soaxHtml && soaxHtml.trim().length > 0);
    const soaxLatency = Date.now() - soaxStartedAt;
    log?.info({ domain, module: 'http', event: 'soax_html', ok: soaxOk, latencyMs: soaxLatency });

    if (soaxOk) {
      trace.push({ lane: 'browser', source: 'soax', ok: true, latencyMs: soaxLatency });
      return { html: soaxHtml!, source: 'soax', trace };
    }

    trace.push({
      lane: 'browser',
      source: 'soax',
      ok: false,
      latencyMs: soaxLatency,
      errorCode: options.soax ? 'EMPTY_BODY' : 'NOT_CONFIGURED',
    });
  } catch (error) {
    const soaxLatency = Date.now() - soaxStartedAt;
    const errorCode = normalizeErrorCode(error);
    log?.info({ domain, module: 'http', event: 'soax_html', ok: false, latencyMs: soaxLatency, errorCode });
    trace.push({ lane: 'browser', source: 'soax', ok: false, latencyMs: soaxLatency, errorCode });
  }

  return null;
};

export const selectUniqueIpProxies = (proxies: ProxyConfig[], count: number): ProxyConfig[] => {
  const shuffled = [...proxies];
  shuffleArray(shuffled);
  const selected: ProxyConfig[] = [];
  const usedIps = new Set<string>();

  for (const proxy of shuffled) {
    if (selected.length >= count) break;
    if (!usedIps.has(proxy.host)) {
      selected.push(proxy);
      usedIps.add(proxy.host);
    }
  }

  return selected;
};

export { readBoundedText };

export const buildFetchTraceEntry = (
  lane: FetchTrace['lane'],
  source: FetchTrace['source'],
  startedAt: number,
  error?: unknown,
): FetchTrace => {
  return {
    lane,
    source,
    ok: !error,
    latencyMs: Date.now() - startedAt,
    errorCode: error ? normalizeErrorCode(error) : undefined,
  };
};
