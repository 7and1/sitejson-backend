import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DnsProvider } from '../dns.provider.js';

const { fetchWithRetry, readBoundedText } = vi.hoisted(() => ({
  fetchWithRetry: vi.fn(),
  readBoundedText: vi.fn(),
}));

vi.mock('../http.js', () => ({
  fetchWithRetry,
  readBoundedText,
}));

describe('DnsProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('merges root TXT and _dmarc TXT records into txtRecords', async () => {
    fetchWithRetry.mockResolvedValue({});
    readBoundedText
      .mockResolvedValueOnce(JSON.stringify({ Answer: [{ data: '203.0.113.10' }] }))
      .mockResolvedValueOnce(JSON.stringify({ Answer: [{ data: '2001:db8::10' }] }))
      .mockResolvedValueOnce(JSON.stringify({ Answer: [{ data: '0 issue "letsencrypt.org"' }] }))
      .mockResolvedValueOnce(JSON.stringify({ Answer: [{ data: 'mx.example.com.' }] }))
      .mockResolvedValueOnce(JSON.stringify({ Answer: [{ data: 'ns1.example.com.' }] }))
      .mockResolvedValueOnce(JSON.stringify({ Answer: [{ data: '"v=spf1 include:_spf.example.com ~all"' }] }))
      .mockResolvedValueOnce(JSON.stringify({ Answer: [{ data: '"v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"' }] }));

    const provider = new DnsProvider({
      timeoutMs: 1000,
      retryAttempts: 0,
      retryBaseMs: 1,
    });

    const result = await provider.run({
      domain: 'example.com',
      url: 'https://example.com',
      traceId: 'trc_dns',
      startedAt: Date.now(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.data) {
      throw new Error('expected dns provider success');
    }

    expect(fetchWithRetry).toHaveBeenNthCalledWith(
      7,
      'https://cloudflare-dns.com/dns-query?name=_dmarc.example.com&type=TXT',
      expect.any(Object),
    );
    expect(result.data.aRecords).toEqual(['203.0.113.10']);
    expect(result.data.aaaaRecords).toEqual(['2001:db8::10']);
    expect(result.data.caaRecords).toEqual(['0 issue "letsencrypt.org"']);
    expect(result.data.txtRecords).toEqual([
      '"v=spf1 include:_spf.example.com ~all"',
      '"v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"',
    ]);
  });
});
