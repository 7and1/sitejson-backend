import { describe, expect, it } from 'vitest';
import { calculateLegitimacyScore } from '../legitimacy.js';

describe('calculateLegitimacyScore', () => {
  it('returns bounded score and signals', () => {
    const result = calculateLegitimacyScore({
      domain: 'example.com',
      updatedAt: new Date().toISOString(),
      dns: {
        provider: 'Cloudflare',
        mxRecords: ['aspmx.l.google.com'],
      },
      seo: {
        h1Count: 1,
        h2Count: 2,
        internalLinks: 10,
        externalLinks: 1,
        imagesCount: 3,
      },
      aiAnalysis: {
        risk: {
          sentiment: 'Professional',
          score: 90,
          isSpam: false,
        },
      },
    });

    expect(result.value).toBeGreaterThan(0);
    expect(result.value).toBeLessThanOrEqual(100);
    expect(result.signals).toContain('has_mx');
  });

  it('applies spam penalty', () => {
    const result = calculateLegitimacyScore({
      domain: 'bad.example',
      updatedAt: new Date().toISOString(),
      aiAnalysis: {
        risk: {
          sentiment: 'Spammy',
          score: 10,
          isSpam: true,
        },
      },
    });

    expect(result.value).toBe(0);
    expect(result.signals).toContain('spam_signal');
  });

  it('penalizes domains expiring within 30 days', () => {
    const soon = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
    const result = calculateLegitimacyScore({
      domain: 'expiring.example',
      updatedAt: new Date().toISOString(),
      trafficData: {
        whois: { expiresAt: soon },
      },
    });

    expect(result.signals).toContain('domain_expires_soon');
  });

  it('penalizes domains with clientHold status', () => {
    const result = calculateLegitimacyScore({
      domain: 'held.example',
      updatedAt: new Date().toISOString(),
      trafficData: {
        whois: { status: ['clientHold'] },
      },
    });

    expect(result.signals).toContain('domain_held');
  });

  it('awards has_sitemap_directives when robotsSitemapUrls present', () => {
    const result = calculateLegitimacyScore({
      domain: 'sitemap.example',
      updatedAt: new Date().toISOString(),
      files: {
        hasRobots: true,
        hasSitemap: true,
        robotsSitemapUrls: ['https://example.com/sitemap.xml'],
      },
    });

    expect(result.signals).toContain('has_sitemap_directives');
  });

  it('awards has_direct_ads when directCount > 0', () => {
    const result = calculateLegitimacyScore({
      domain: 'ads.example',
      updatedAt: new Date().toISOString(),
      publisher: {
        hasAdsTxt: true,
        adSystems: ['google.com'],
        directCount: 3,
        resellerCount: 1,
        monetizationSignals: ['ads.txt'],
      },
    });

    expect(result.signals).toContain('has_direct_ads');
    expect(result.signals).toContain('has_ads_txt');
  });

  it('does not penalize domains expiring far in the future', () => {
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const result = calculateLegitimacyScore({
      domain: 'healthy.example',
      updatedAt: new Date().toISOString(),
      trafficData: {
        whois: { expiresAt: farFuture, status: ['ok'] },
      },
    });

    expect(result.signals).not.toContain('domain_expires_soon');
    expect(result.signals).not.toContain('domain_held');
  });
});
