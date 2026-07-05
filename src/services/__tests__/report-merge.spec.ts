import { describe, expect, it } from 'vitest';
import { guardBlockedSiteReport, mergeSiteReports, sanitizeSiteReport } from '../report-merge.js';

describe('mergeSiteReports', () => {
  it('keeps existing whois/domainAge when new traffic payload has nullish backfill fields', () => {
    const previous = {
      domain: 'example.com',
      updatedAt: '2026-02-01T00:00:00.000Z',
      trafficData: {
        monthlyVisits: 100,
        domainAgeYears: 12.3,
        whois: {
          registrar: 'Example Registrar',
          createdAt: '2013-01-01T00:00:00Z',
          expiresAt: null,
          updatedAt: null,
          nameservers: ['ns1.example.com'],
          status: ['active'],
        },
      },
    };

    const next = {
      domain: 'example.com',
      updatedAt: '2026-02-02T00:00:00.000Z',
      trafficData: {
        monthlyVisits: 200,
        domainAgeYears: null,
        whois: undefined,
      },
    };

    const merged = mergeSiteReports(previous as any, next as any);

    expect(merged.trafficData?.monthlyVisits).toBe(200);
    expect(merged.trafficData?.domainAgeYears).toBe(12.3);
    expect(merged.trafficData?.whois?.registrar).toBe('Example Registrar');
  });

  it('applies whois/domainAge update without overriding existing traffic metrics', () => {
    const previous = {
      domain: 'example.com',
      updatedAt: '2026-02-01T00:00:00.000Z',
      trafficData: {
        monthlyVisits: 188,
        domainAgeYears: 12.3,
        whois: {
          registrar: 'Old Registrar',
          createdAt: '2013-01-01T00:00:00Z',
          expiresAt: null,
          updatedAt: null,
          nameservers: [],
          status: [],
        },
      },
    };

    const next = {
      domain: 'example.com',
      updatedAt: '2026-02-02T00:00:00.000Z',
      trafficData: {
        domainAgeYears: 2.1,
        whois: {
          registrar: 'New Registrar',
          createdAt: '2024-01-01T00:00:00Z',
          expiresAt: null,
          updatedAt: null,
          nameservers: [],
          status: [],
        },
      },
    };

    const merged = mergeSiteReports(previous as any, next as any);

    expect(merged.trafficData?.monthlyVisits).toBe(188);
    expect(merged.trafficData?.domainAgeYears).toBe(2.1);
    expect(merged.trafficData?.whois?.registrar).toBe('New Registrar');
  });

  it('merges whois fields with previous snapshot when new payload is partial', () => {
    const previous = {
      domain: 'example.com',
      updatedAt: '2026-02-01T00:00:00.000Z',
      trafficData: {
        whois: {
          registrar: 'Legacy Registrar',
          createdAt: null,
          expiresAt: '2030-01-01T00:00:00Z',
          updatedAt: null,
          nameservers: ['ns1.example.com', 'ns2.example.com'],
          status: ['ok'],
        },
      },
    };

    const next = {
      domain: 'example.com',
      updatedAt: '2026-02-02T00:00:00.000Z',
      trafficData: {
        whois: {
          registrar: null,
          createdAt: '2018-01-01T00:00:00Z',
          expiresAt: null,
          updatedAt: null,
          nameservers: [],
          status: ['clientTransferProhibited'],
        },
        domainAgeYears: 8.1,
      },
    };

    const merged = mergeSiteReports(previous as any, next as any);

    expect(merged.trafficData?.whois?.registrar).toBe('Legacy Registrar');
    expect(merged.trafficData?.whois?.createdAt).toBe('2018-01-01T00:00:00Z');
    expect(merged.trafficData?.whois?.expiresAt).toBe('2030-01-01T00:00:00Z');
    expect(merged.trafficData?.whois?.nameservers).toEqual(['ns1.example.com', 'ns2.example.com']);
    expect(merged.trafficData?.whois?.status).toEqual(['clientTransferProhibited']);
    expect(merged.trafficData?.domainAgeYears).toBe(8.1);
  });

  it('merges providerHealth by provider key across lanes', () => {
    const previous = {
      domain: 'example.com',
      updatedAt: '2026-02-01T00:00:00.000Z',
      providerHealth: [
        { provider: 'meta.provider', ok: true },
        { provider: 'traffic.provider', ok: false, errorCode: 'TIMEOUT' },
      ],
    };

    const next = {
      domain: 'example.com',
      updatedAt: '2026-02-02T00:00:00.000Z',
      providerHealth: [
        { provider: 'traffic.provider', ok: true },
        { provider: 'whois.provider', ok: true },
      ],
    };

    const merged = mergeSiteReports(previous as any, next as any);
    expect(merged.providerHealth).toEqual([
      { provider: 'meta.provider', ok: true },
      { provider: 'traffic.provider', ok: true },
      { provider: 'whois.provider', ok: true },
    ]);
  });

  it('preserves score while stripping legacy seo.contacts fields', () => {
    const report = sanitizeSiteReport({
      domain: 'example.com',
      updatedAt: '2026-02-01T00:00:00.000Z',
      seo: {
        h1Count: 1,
        contacts: {
          phones: ['123456789'],
        },
      },
      score: {
        value: 10,
        signals: ['legacy_score'],
      },
    } as any);

    expect(report.score).toEqual({
      value: 10,
      signals: ['legacy_score'],
    });
    expect(((report.seo ?? {}) as Record<string, unknown>).contacts).toBeUndefined();
    expect(report.seo?.h1Count).toBe(1);
  });

  it('sanitizes providerHealth and publisher.adSystems tokens', () => {
    const report = sanitizeSiteReport({
      domain: 'example.com',
      updatedAt: '2026-02-01T00:00:00.000Z',
      providerHealth: [
        { provider: 'meta.provider', ok: true },
        { provider: 'meta.provider', ok: false, errorCode: 'TIMEOUT' },
        { provider: '   ', ok: true },
        'invalid' as any,
        { provider: 'dns.provider', ok: 'yes' as any },
      ],
      publisher: {
        hasAdsTxt: true,
        adSystems: [
          'google.com',
          '<script>alert(1)</script>',
          'ownerDomain=Foo.COM',
          'bad token',
          'google.com',
          123 as any,
        ],
      },
    } as any);

    expect(report.providerHealth).toEqual([
      { provider: 'meta.provider', ok: false, errorCode: 'TIMEOUT' },
    ]);
    expect(report.publisher?.adSystems).toEqual([
      'google.com',
      'foo.com',
    ]);
  });

  it('keeps score from previous report while dropping legacy seo.contacts fields during merge', () => {
    const previous = {
      domain: 'example.com',
      updatedAt: '2026-02-01T00:00:00.000Z',
      seo: {
        h1Count: 1,
        contacts: {
          emails: ['legacy@example.com'],
        },
      },
      score: {
        value: 30,
        signals: ['previous_score'],
      },
    };

    const next = {
      domain: 'example.com',
      updatedAt: '2026-02-02T00:00:00.000Z',
      seo: {
        h2Count: 5,
      },
    };

    const merged = mergeSiteReports(previous as any, next as any);
    expect(merged.score).toEqual({
      value: 30,
      signals: ['previous_score'],
    });
    expect(((merged.seo ?? {}) as Record<string, unknown>).contacts).toBeUndefined();
    expect(merged.seo?.h1Count).toBe(1);
    expect(merged.seo?.h2Count).toBe(5);
  });

  it('guards blocked crawl artifacts for API output', () => {
    const guarded = guardBlockedSiteReport({
      domain: 'example.com',
      updatedAt: '2026-02-02T00:00:00.000Z',
      meta: {
        title: 'Example title',
        description: 'Example description',
        techStackDetected: ['React'],
      },
      seo: {
        h1Count: 1,
      },
      taxonomy: {
        iabCategory: 'Technology & Computing',
        tags: ['saas'],
      },
      aiAnalysis: {
        risk: {
          sentiment: 'Professional',
          score: 8,
          isSpam: false,
        },
      },
      visual: {
        screenshotUrl: 'https://cdn.example.com/example.webp',
        dominantColor: '#112233',
        palette: ['#112233', '#445566'],
      },
      providerHealth: [
        { provider: 'meta.provider', ok: true },
      ],
      _meta: {
        html: {
          blocked: true,
          source: 'browser',
          length: 1200,
          primary_h1: 'Example heading',
        },
      },
    } as any);

    expect(guarded.meta).toBeUndefined();
    expect(guarded.seo).toBeUndefined();
    expect(guarded.taxonomy).toBeUndefined();
    expect(guarded.aiAnalysis).toBeUndefined();
    expect(guarded.visual).toEqual({
      screenshotUrl: 'https://cdn.example.com/example.webp',
    });
    expect(guarded._meta?.html).toMatchObject({
      blocked: true,
      length: 0,
    });
    expect(guarded.providerHealth).toEqual(expect.arrayContaining([
      { provider: 'meta.provider', ok: false, errorCode: 'BOT_CHALLENGE_BLOCKED' },
      { provider: 'seo.provider', ok: false, errorCode: 'BOT_CHALLENGE_BLOCKED' },
      { provider: 'ai.provider', ok: false, errorCode: 'BOT_CHALLENGE_BLOCKED' },
    ]));
  });

  it('does not carry previous page-content fields forward when the new crawl is blocked', () => {
    const previous = {
      domain: 'example.com',
      updatedAt: '2026-02-01T00:00:00.000Z',
      meta: {
        title: 'Real title',
        description: 'Real description',
        techStackDetected: ['Next.js'],
      },
      seo: {
        h1Count: 2,
        internalLinks: 15,
      },
      taxonomy: {
        iabCategory: 'Technology & Computing',
        tags: ['saas'],
      },
      aiAnalysis: {
        risk: {
          sentiment: 'Professional',
          score: 4,
          isSpam: false,
        },
      },
      visual: {
        screenshotUrl: 'https://cdn.example.com/real.webp',
        dominantColor: '#112233',
        palette: ['#112233', '#445566'],
      },
      trafficData: {
        monthlyVisits: 1000,
      },
    };

    const next = {
      domain: 'example.com',
      updatedAt: '2026-02-02T00:00:00.000Z',
      visual: {
        screenshotUrl: 'https://cdn.example.com/blocked.webp',
      },
      providerHealth: [
        { provider: 'meta.provider', ok: false, errorCode: 'BOT_CHALLENGE_BLOCKED' },
      ],
      _meta: {
        html: {
          blocked: true,
          source: 'browser',
          length: 0,
        },
      },
    };

    const merged = mergeSiteReports(previous as any, next as any);

    expect(merged.meta).toBeUndefined();
    expect(merged.seo).toBeUndefined();
    expect(merged.taxonomy).toBeUndefined();
    expect(merged.aiAnalysis).toBeUndefined();
    expect(merged.visual).toEqual({
      screenshotUrl: 'https://cdn.example.com/blocked.webp',
    });
    expect(merged.trafficData?.monthlyVisits).toBe(1000);
    expect(merged._meta?.html).toMatchObject({
      blocked: true,
      length: 0,
    });
  });
});
