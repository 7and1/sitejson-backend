import { describe, it, expect, vi } from 'vitest';
import {
  extractSimilarwebPayload,
  parseRscResponse,
  transformSimilarwebData,
} from '../traffic.provider.js';

vi.mock('undici', () => ({
  Agent: class {},
  ProxyAgent: class {},
  fetch: globalThis.fetch,
}), { virtual: true });

describe('TrafficProvider Parser', () => {
  const mockRscResponse = `
    0:{"b":"123","f":[["children",["hostname","google.com"],"$undefined","$undefined",true],
    ["children",["traffic",{"overview":{"visits":"93404539742","globalRank":1,"countryRank":1,"bounceRate":"11.65","timeOnSite":"1444.43","pagePerVisit":"8.87","year":"2025","month":"11"},"monthlyVisits":{"2025-08-01":94616315520,"2025-09-01":94137119453,"2025-10-01":93404539742},"trafficSources":{"mail":2,"direct":35,"search":45,"social":10,"referrals":6,"paidReferrals":2},"topKeywords":[{"name":"google","volume":1000000,"cpc":2.5}],"topRegions":[{"country":840,"name":"United States","value":0.25}]},"whois":{"events":[{"eventAction":"registration","eventDate":"2010-05-15T00:00:00Z"}]}}]]
  `;

  it('should parse traffic data from RSC response', () => {
    const result = parseRscResponse(mockRscResponse);

    expect(result).not.toBeNull();
    expect(result?.traffic?.overview?.globalRank).toBe(1);
    expect(result?.traffic?.overview?.visits).toBe('93404539742');
    expect(result?.traffic?.monthlyVisits).toBeDefined();
    expect(Object.keys(result?.traffic?.monthlyVisits ?? {})).toHaveLength(3);
  });

  it('should extract traffic sources', () => {
    const result = parseRscResponse(mockRscResponse);
    const sources = result?.traffic?.trafficSources;

    expect(sources?.direct).toBe(35);
    expect(sources?.search).toBe(45);
    expect(sources?.social).toBe(10);
  });

  it('should extract whois domain age event', () => {
    const result = parseRscResponse(mockRscResponse);
    const regEvent = result?.whois?.events?.find(
      (e) => e.eventAction === 'registration',
    );

    expect(regEvent).toBeDefined();
    expect(regEvent?.eventDate).toBe('2010-05-15T00:00:00Z');
  });

  it('should return null for invalid response', () => {
    const result = parseRscResponse('invalid response');
    expect(result).toBeNull();
  });

  it('should parse SimilarWeb API envelope payload', () => {
    const payload = extractSimilarwebPayload({
      data: {
        monthly_visits: 123456,
        global_rank: 2345,
        country_rank: 123,
        snapshot_date: '2026-01-10',
      },
    });

    expect(payload).not.toBeNull();
    expect(payload?.monthly_visits).toBe(123456);
    expect(payload?.global_rank).toBe(2345);
  });

  it('should transform SimilarWeb payload to trafficData shape', () => {
    const trafficData = transformSimilarwebData({
      monthly_visits: 987654,
      global_rank: 321,
      country_rank: 12,
      bounce_rate: 49.5,
      pages_per_visit: 2.8,
      avg_visit_duration: 214.3,
      stale: true,
      data_age_days: 47,
      snapshot_date: '2026-01-10',
      last_updated: '2026-02-03T04:05:06Z',
      traffic_sources: {
        direct: 31,
        referral: 19,
        search: 33,
        social: 8,
        mail: 4,
        display: 5,
      },
      top_keywords: [
        { keyword: 'sitejson', volume: 1200, cpc: 0.9 },
      ],
      top_country_shares: [
        { country: 'United States', share: 0.42, countryCode: 840 },
      ],
    });

    expect(trafficData.monthlyVisits).toBe(987654);
    expect(trafficData.globalRank).toBe(321);
    expect(trafficData.countryRank).toBe(12);
    expect(trafficData.dataYear).toBe('2026');
    expect(trafficData.dataMonth).toBe('01');
    expect(trafficData.isStale).toBe(true);
    expect(trafficData.dataAgeDays).toBe(47);
    expect(trafficData.snapshotDate).toBe('2026-01-10');
    expect(trafficData.trafficSources?.paid).toBe(5);
    expect(trafficData.topKeywords[0]?.keyword).toBe('sitejson');
    expect(trafficData.topRegions[0]?.country).toBe('United States');
    expect(trafficData.cachedAt).toBe(1770091506);
  });

  it('should transform ProxyGrid similarweb payload shape', () => {
    const payload = extractSimilarwebPayload({
      status: 200,
      domain: 'openai.com',
      data: {
        EstimatedMonthlyVisits: { '2026-01-01': 210067289 },
        GlobalRank: { Rank: 223 },
        CountryRank: { Rank: 331, CountryCode: 'US' },
        Engagments: {
          BounceRate: '0.6315',
          PagePerVisit: '2.39',
          TimeOnSite: '121.42',
          Year: '2026',
          Month: '1',
          Visits: '210067289',
        },
        TrafficSources: {
          Direct: 0.4017,
          Search: 0.5034,
          Referrals: 0.0864,
          Social: 0.0044,
          Mail: 0.0007,
          'Paid Referrals': 0.0031,
        },
        TopCountryShares: [
          { Country: 840, CountryCode: 'US', Value: 0.2061 },
        ],
      },
    });

    expect(payload).not.toBeNull();
    const trafficData = transformSimilarwebData(payload!);
    expect(trafficData.monthlyVisits).toBe(210067289);
    expect(trafficData.globalRank).toBe(223);
    expect(trafficData.countryRank).toBe(331);
    expect(trafficData.dataYear).toBe('2026');
    expect(trafficData.dataMonth).toBe('01');
    expect(trafficData.isStale).toBeNull();
    expect(trafficData.dataAgeDays).toBeNull();
    expect(trafficData.snapshotDate).toBeNull();
    expect(trafficData.trafficSources?.direct).toBeCloseTo(0.4017, 4);
    expect(trafficData.trafficSources?.paid).toBeCloseTo(0.0031, 4);
    expect(trafficData.topRegions[0]?.countryCode).toBe(840);
    expect(trafficData.topRegions[0]?.country).toBe('US');
    expect(trafficData.cachedAt).toBeNull();
  });
});
