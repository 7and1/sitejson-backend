import { describe, expect, it } from 'vitest';
import { looksBlocked, looksBlockedError, trafficCvHeaders } from '../anti-bot.js';

describe('trafficCvHeaders', () => {
  it('builds strict RSC fetch headers for traffic.cv', () => {
    const headers = trafficCvHeaders(
      'example.com',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    );

    expect(headers.Accept).toBe('text/x-component, */*');
    expect(headers.RSC).toBe('1');
    expect(headers['Sec-Fetch-Dest']).toBe('empty');
    expect(headers['Sec-Fetch-Mode']).toBe('same-origin');
    expect(headers['Sec-Fetch-Site']).toBe('same-origin');
    expect(headers.Referer).toBe('https://traffic.cv/example.com');
    expect(headers['Sec-Fetch-User']).toBeUndefined();
  });
});

describe('block detection', () => {
  it('detects block status and challenge markers', () => {
    expect(looksBlocked(403)).toBe(true);
    expect(looksBlocked(200, '<html><title>Just a moment...</title>cf-chl</html>')).toBe(true);
    expect(looksBlocked(200, '{"ok":true}')).toBe(false);
  });

  it('detects blocked network errors', () => {
    expect(looksBlockedError(new Error('HTTP_403'))).toBe(true);
    expect(looksBlockedError(new Error('timeout'))).toBe(false);
  });
});
