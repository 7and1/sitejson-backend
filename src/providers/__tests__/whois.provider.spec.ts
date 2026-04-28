import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from '../http.js';
import { WhoisProvider } from '../whois.provider.js';

const options = {
  timeoutMs: 1000,
  retryAttempts: 0,
  retryBaseMs: 1,
};

const context = {
  domain: 'example.com',
  url: 'https://example.com',
  traceId: 'trc_whois',
  startedAt: Date.now(),
};

describe('WhoisProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed whois + domain age from rdap payload', async () => {
    vi.spyOn(http, 'fetchWithRetry').mockImplementation(async (url) => {
      if (url.includes('data.iana.org/rdap/dns.json')) {
        return new Response(JSON.stringify({ services: [] }));
      }

      return new Response(JSON.stringify({
        events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }],
        entities: [{
          roles: ['registrar'],
          vcardArray: ['vcard', [['fn', {}, 'text', 'Example Registrar']]],
        }],
        nameservers: [{ ldhName: 'ns1.example.com' }],
        status: ['active'],
      }));
    });

    const provider = new WhoisProvider(options, 'SiteJSONTest/1.0');
    const result = await provider.run(context);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.whois?.registrar).toBe('Example Registrar');
      expect(result.data.whois?.createdAt).toBe('2020-01-01T00:00:00Z');
      expect(typeof result.data.domainAgeYears).toBe('number');
      expect(result.data.domainAgeYears).toBeGreaterThan(0);
    }
  });

  it('returns empty snapshot for RDAP 404', async () => {
    vi.spyOn(http, 'fetchWithRetry').mockImplementation(async (url) => {
      if (url.includes('data.iana.org/rdap/dns.json')) {
        return new Response(JSON.stringify({ services: [] }));
      }
      throw new Error('HTTP_404');
    });

    const provider = new WhoisProvider(options, 'SiteJSONTest/1.0');
    const result = await provider.run(context);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.whois).toBeNull();
      expect(result.data.domainAgeYears).toBeNull();
    }
  });

  it('falls back to registry source when rdap.org has no data', async () => {
    vi.spyOn(http, 'fetchWithRetry').mockImplementation(async (url) => {
      if (url.includes('data.iana.org/rdap/dns.json')) {
        return new Response(JSON.stringify({
          services: [
            [['com'], ['https://registry.example.test/rdap']],
          ],
        }));
      }

      if (url.includes('https://rdap.org/domain/')) {
        throw new Error('HTTP_404');
      }

      if (url.includes('https://rdap.verisign.com/com/v1/domain/')) {
        throw new Error('HTTP_404');
      }

      if (url.includes('https://registry.example.test/rdap/domain/')) {
        return new Response(JSON.stringify({
          events: [{ eventAction: 'registration', eventDate: '2019-05-20T00:00:00Z' }],
          entities: [{
            roles: ['registrar'],
            vcardArray: ['vcard', [['fn', {}, 'text', 'Fallback Registrar']]],
          }],
          nameservers: [{ ldhName: 'ns1.fallback.test' }],
          status: ['active'],
        }));
      }

      throw new Error(`UNEXPECTED_URL:${url}`);
    });

    const provider = new WhoisProvider(options, 'SiteJSONTest/1.0');
    const result = await provider.run(context);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.whois?.registrar).toBe('Fallback Registrar');
      expect(result.data.whois?.createdAt).toBe('2019-05-20T00:00:00Z');
      expect(typeof result.data.domainAgeYears).toBe('number');
    }
  });
});
