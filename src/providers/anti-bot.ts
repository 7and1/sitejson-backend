/**
 * Traffic anti-bot helpers adapted from Proxy-Grid production implementation:
 * - heavy-tasks/Proxy-Grid/gateway/lib/anti-bot.ts
 * - heavy-tasks/Proxy-Grid/gateway/lib/proxy.ts (looksBlocked)
 */

const BROWSER_VERSIONS = {
  chrome: Array.from({ length: 31 }, (_, i) => `${120 + i}.0.0.0`), // 120-150
  firefox: Array.from({ length: 41 }, (_, i) => `${100 + i}.0`), // 100-140
  edge: Array.from({ length: 31 }, (_, i) => `${120 + i}.0.0.0`), // 120-150
  opera: Array.from({ length: 30 }, (_, i) => `${100 + i}.0.0.0`), // 100-129
};

const SYSTEM_INFO = {
  macos: [
    'Macintosh; Intel Mac OS X 10_15_7',
    'Macintosh; Intel Mac OS X 11_0_0',
    'Macintosh; Intel Mac OS X 12_0_0',
    'Macintosh; Intel Mac OS X 13_0_0',
    'Macintosh; Intel Mac OS X 14_0_0',
  ],
  windows: [
    'Windows NT 10.0; Win64; x64',
    'Windows NT 10.0; WOW64',
    'Windows NT 11.0; Win64; x64',
  ],
  linux: [
    'X11; Linux x86_64',
    'X11; Ubuntu; Linux x86_64',
    'X11; Fedora; Linux x86_64',
  ],
};

const ACCEPT_HEADERS = [
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
];

const ACCEPT_JSON = [
  'application/json, text/plain, */*',
  'application/json;q=0.9, */*;q=0.8',
];

const ACCEPT_LANGUAGE = [
  'en-US,en;q=0.9',
  'en-US,en;q=0.8,ja;q=0.6',
  'en-US,en;q=0.8,zh-CN;q=0.5',
  'en-GB,en;q=0.8',
];

let uaPool: string[] = [];

const randomChoice = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

export const shuffleArray = <T>(arr: T[]): void => {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
};

const initUaPool = (): void => {
  if (uaPool.length > 0) return;

  const generated: string[] = [];
  const platforms = ['macos', 'windows', 'linux'] as const;

  for (const platform of platforms) {
    const systems = SYSTEM_INFO[platform];

    for (const sys of systems) {
      for (const ver of BROWSER_VERSIONS.chrome) {
        generated.push(
          `Mozilla/5.0 (${sys}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`,
        );
      }
    }

    for (const sys of systems) {
      for (const ver of BROWSER_VERSIONS.firefox) {
        generated.push(
          `Mozilla/5.0 (${sys}; rv:${ver}) Gecko/20100101 Firefox/${ver}`,
        );
      }
    }

    if (platform === 'windows' || platform === 'macos') {
      for (const sys of systems) {
        for (const ver of BROWSER_VERSIONS.edge) {
          generated.push(
            `Mozilla/5.0 (${sys}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36 Edg/${ver}`,
          );
        }
      }
    }

    for (const sys of systems) {
      for (const operaVer of BROWSER_VERSIONS.opera.slice(0, 10)) {
        const chromeVer = randomChoice(BROWSER_VERSIONS.chrome.slice(0, 10));
        generated.push(
          `Mozilla/5.0 (${sys}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36 OPR/${operaVer}`,
        );
      }
    }
  }

  uaPool = Array.from(new Set(generated));
};

const detectPlatform = (ua: string): 'Windows' | 'macOS' | 'Linux' => {
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Macintosh')) return 'macOS';
  return 'Linux';
};

const extractChromeMajor = (ua: string): string => {
  const match = ua.match(/Chrome\/(\d+)/);
  return match?.[1] ?? '131';
};

export const shuffleHeaders = (headers: Record<string, string>): Record<string, string> => {
  const entries = Object.entries(headers);
  shuffleArray(entries);
  return Object.fromEntries(entries);
};

export const generateRandomUA = (): string => {
  initUaPool();
  return randomChoice(uaPool);
};

export const generateChromeUA = (): string => {
  const system = randomChoice([...SYSTEM_INFO.macos, ...SYSTEM_INFO.windows]);
  const version = randomChoice(BROWSER_VERSIONS.chrome);
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
};

export interface HeaderOptions {
  contentType?: 'html' | 'json';
  referer?: string;
  includeSecChUa?: boolean;
  includeSecFetch?: boolean;
}

export const generateBrowserHeaders = (
  userAgent: string,
  options: HeaderOptions = {},
): Record<string, string> => {
  const contentType = options.contentType ?? 'html';
  const includeSecChUa = options.includeSecChUa ?? true;
  const includeSecFetch = options.includeSecFetch ?? true;

  const platform = detectPlatform(userAgent);
  const headers: Record<string, string> = {
    'User-Agent': userAgent,
    Accept: contentType === 'json' ? randomChoice(ACCEPT_JSON) : randomChoice(ACCEPT_HEADERS),
    'Accept-Language': randomChoice(ACCEPT_LANGUAGE),
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
  };

  if (options.referer) {
    headers.Referer = options.referer;
  }

  if (contentType === 'html') {
    headers['Upgrade-Insecure-Requests'] = '1';
  }

  if (includeSecFetch) {
    headers['Sec-Fetch-Dest'] = contentType === 'json' ? 'empty' : 'document';
    headers['Sec-Fetch-Mode'] = contentType === 'json' ? 'cors' : 'navigate';
    headers['Sec-Fetch-Site'] = options.referer ? 'cross-site' : 'none';
    headers['Sec-Fetch-User'] = '?1';
  }

  if (includeSecChUa) {
    const major = extractChromeMajor(userAgent);
    headers['sec-ch-ua'] = `"Chromium";v="${major}", "Not_A Brand";v="24"`;
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = `"${platform}"`;
  }

  return headers;
};

/**
 * Strict RSC request headers for traffic.cv `?_rsc=1`.
 * Important: this is NOT a page navigation request.
 */
export const trafficCvHeaders = (domain: string, userAgent = generateChromeUA()): Record<string, string> => {
  const referer = `https://traffic.cv/${encodeURIComponent(domain)}`;
  const headers = generateBrowserHeaders(userAgent, {
    contentType: 'json',
    referer,
    includeSecChUa: true,
    includeSecFetch: false, // force strict RSC values below
  });

  const strictHeaders: Record<string, string> = {
    ...headers,
    Accept: 'text/x-component, */*',
    RSC: '1',
    'Next-Router-State-Tree': '%5B%22%22%5D',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'same-origin',
    'Sec-Fetch-Site': 'same-origin',
    Referer: referer,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };

  delete strictHeaders['Sec-Fetch-User'];
  delete strictHeaders.Origin;

  return shuffleHeaders(strictHeaders);
};

/**
 * Adapted from Proxy-Grid `looksBlocked` with additional Cloudflare challenge markers.
 */
export const looksBlocked = (status: number, body?: string | null): boolean => {
  if (status === 403 || status === 429 || status === 503) return true;
  if (!body) return false;

  const text = body.toLowerCase();
  return (
    text.includes('captcha')
    || text.includes('access denied')
    || text.includes('unusual traffic')
    || text.includes('managed challenge')
    || text.includes('just a moment')
    || text.includes('cf-chl')
    || text.includes('cf_clearance')
    || text.includes('cloudflare')
  );
};

export const looksBlockedError = (error: unknown): boolean => {
  const message = (error instanceof Error ? error.message : String(error)).toUpperCase();
  return (
    message.includes('HTTP_403')
    || message.includes('HTTP_429')
    || message.includes('HTTP_503')
    || message.includes('CAPTCHA')
    || message.includes('CLOUDFLARE')
  );
};
