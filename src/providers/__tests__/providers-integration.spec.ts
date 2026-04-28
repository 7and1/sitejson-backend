import { describe, expect, it } from 'vitest';
import { MetaProvider } from '../meta.provider.js';
import { SeoProvider } from '../seo.provider.js';
import { DnsProvider } from '../dns.provider.js';
import { TrafficProvider } from '../traffic.provider.js';
import { FilesProvider } from '../files.provider.js';
import { AdsProvider } from '../ads.provider.js';
import { PublisherProvider } from '../publisher.provider.js';
import type { CrawlContext } from '../../core/types.js';

const TEST_DOMAINS = ['google.com', 'github.com', 'cloudflare.com'];

const createContext = (domain: string): CrawlContext => ({
  domain,
  url: `https://${domain}`,
  traceId: `trc_integration_${domain.replace(/\W/g, '_')}`,
  startedAt: Date.now(),
});

const options = {
  timeoutMs: 15000,
  retryAttempts: 2,
  retryBaseMs: 500,
};

describe.skip('Provider Integration Tests', () => {
  describe('DnsProvider', () => {
    const provider = new DnsProvider(options);

    it.each(TEST_DOMAINS)('should fetch DNS for %s', async (domain) => {
      const ctx = createContext(domain);
      const result = await provider.run(ctx);

      expect(result.ok).toBe(true);
      if (result.ok && result.data) {
        expect(result.data.provider).toBeDefined();
        expect(Array.isArray(result.data.mxRecords)).toBe(true);
        expect(Array.isArray(result.data.nsRecords)).toBe(true);
        expect(Array.isArray(result.data.txtRecords)).toBe(true);
      }
    }, 20000);
  });

  describe('MetaProvider', () => {
    const provider = new MetaProvider(options, 'SiteJSONBot/1.0');

    it.each(TEST_DOMAINS)('should fetch meta for %s', async (domain) => {
      const ctx = createContext(domain);
      const result = await provider.run(ctx);

      expect(result.ok).toBe(true);
      if (result.ok && result.data) {
        expect(typeof result.data.title).toBe('string');
        expect(Array.isArray(result.data.techStackDetected)).toBe(true);
      }
    }, 20000);
  });

  describe('SeoProvider', () => {
    const provider = new SeoProvider(options, 'SiteJSONBot/1.0');

    it.each(TEST_DOMAINS)('should fetch SEO for %s', async (domain) => {
      const ctx = createContext(domain);
      const result = await provider.run(ctx);

      expect(result.ok).toBe(true);
      if (result.ok && result.data) {
        expect(typeof result.data.h1Count).toBe('number');
        expect(typeof result.data.internalLinks).toBe('number');
        expect(typeof result.data.imagesCount).toBe('number');
      }
    }, 20000);
  });

  describe('FilesProvider', () => {
    const provider = new FilesProvider(options, 'SiteJSONBot/1.0');

    it.each(TEST_DOMAINS)('should check files for %s', async (domain) => {
      const ctx = createContext(domain);
      const result = await provider.run(ctx);

      expect(result.ok).toBe(true);
      if (result.ok && result.data) {
        expect(typeof result.data.hasRobots).toBe('boolean');
        expect(typeof result.data.hasSitemap).toBe('boolean');
        expect(Array.isArray(result.data.robotsSitemapUrls)).toBe(true);
      }
    }, 20000);
  });

  describe('PublisherProvider', () => {
    const provider = new PublisherProvider(options, 'SiteJSONBot/1.0');

    it.each(TEST_DOMAINS)('should check ads.txt for %s', async (domain) => {
      const ctx = createContext(domain);
      const result = await provider.run(ctx);

      expect(result.ok).toBe(true);
      if (result.ok && result.data) {
        expect(typeof result.data.hasAdsTxt).toBe('boolean');
        expect(Array.isArray(result.data.adSystems)).toBe(true);
      }
    }, 20000);
  });

  describe('AdsProvider', () => {
    const provider = new AdsProvider(options, 'SiteJSONBot/1.0');

    it.each(TEST_DOMAINS)('should query ad transparency for %s', async (domain) => {
      const ctx = createContext(domain);
      const result = await provider.run(ctx);

      expect(result.ok).toBe(true);
      if (result.ok && result.data) {
        expect(typeof result.data.isAdvertiser).toBe('boolean');
        expect(Array.isArray(result.data.advertiserIds)).toBe(true);
      }
    }, 20000);
  });

  describe('TrafficProvider', () => {
    const provider = new TrafficProvider(options);

    it.each(TEST_DOMAINS)('should fetch traffic for %s', async (domain) => {
      const ctx = createContext(domain);
      const result = await provider.run(ctx);

      if (result.ok && result.data) {
        expect(typeof result.data.monthlyVisits).toBe('number');
      }
    }, 20000);
  });
});
