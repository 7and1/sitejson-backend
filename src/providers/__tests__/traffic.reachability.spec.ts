import { promises as dns } from 'node:dns';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrafficProvider } from '../traffic.provider.js';

vi.mock('node:dns', () => ({
  promises: {
    resolve4: vi.fn(async () => ['93.184.216.34']),
    resolve6: vi.fn(async () => []),
  },
}));

describe('TrafficProvider reachability gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dns.resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked(dns.resolve6).mockResolvedValue([]);
  });

  it('short-circuits proxy traffic lookups when the domain is not publicly reachable', async () => {
    vi.mocked(dns.resolve4).mockRejectedValueOnce(new Error('DNS_NOT_RESOLVED'));
    vi.mocked(dns.resolve6).mockRejectedValueOnce(new Error('DNS_NOT_RESOLVED'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const provider = new TrafficProvider({
      timeoutMs: 100,
      retryAttempts: 0,
      retryBaseMs: 1,
    });

    const result = await provider.run({
      domain: 'missing.example',
      url: 'https://missing.example',
      traceId: 'trc_traffic_unreachable',
      startedAt: Date.now(),
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TRAFFIC_UNREACHABLE');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
