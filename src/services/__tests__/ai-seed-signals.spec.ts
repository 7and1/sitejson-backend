import { describe, it, expect } from 'vitest';
import { buildAiSeedSignals } from '../ai-seed-signals.js';
import type { SiteReport } from '../../core/types.js';

const baseDomain = 'example.com';

const makeReport = (overrides?: Partial<SiteReport>): SiteReport => ({
  domain: baseDomain,
  updatedAt: new Date().toISOString(),
  ...overrides,
});

describe('buildAiSeedSignals', () => {
  it('returns undefined when previous is null', () => {
    expect(buildAiSeedSignals(baseDomain, null)).toBeUndefined();
  });

  it('returns undefined when previous is undefined', () => {
    expect(buildAiSeedSignals(baseDomain, undefined)).toBeUndefined();
  });

  it('returns undefined when previous has no signals', () => {
    const report = makeReport();
    expect(buildAiSeedSignals(baseDomain, report)).toBeUndefined();
  });

  it('returns undefined when meta has only empty strings', () => {
    const report = makeReport({
      meta: { title: '', description: '', techStackDetected: [] },
    });
    expect(buildAiSeedSignals(baseDomain, report)).toBeUndefined();
  });

  it('returns undefined when meta has only whitespace', () => {
    const report = makeReport({
      meta: { title: '  ', description: '  ', techStackDetected: [] },
    });
    expect(buildAiSeedSignals(baseDomain, report)).toBeUndefined();
  });

  it('builds signals from meta title', () => {
    const report = makeReport({
      meta: { title: 'Example Site', description: '', techStackDetected: [] },
    });
    const result = buildAiSeedSignals(baseDomain, report);
    expect(result).toBeDefined();
    expect(result!.title).toBe('Example Site');
    expect(result!.description).toBe('');
    expect(result!.h1Count).toBe(0);
  });

  it('builds signals from meta description', () => {
    const report = makeReport({
      meta: { title: '', description: 'A great site', techStackDetected: [] },
    });
    const result = buildAiSeedSignals(baseDomain, report);
    expect(result).toBeDefined();
    expect(result!.title).toBe(baseDomain); // falls back to domain
    expect(result!.description).toBe('A great site');
  });

  it('builds signals from seo data', () => {
    const report = makeReport({
      seo: { h1Count: 3, h2Count: 5, internalLinks: 10, externalLinks: 2, imagesCount: 8 },
    });
    const result = buildAiSeedSignals(baseDomain, report);
    expect(result).toBeDefined();
    expect(result!.h1Count).toBe(3);
    expect(result!.h2Count).toBe(5);
    expect(result!.internalLinks).toBe(10);
    expect(result!.externalLinks).toBe(2);
    expect(result!.imagesCount).toBe(8);
  });

  it('builds full signals from complete report', () => {
    const report = makeReport({
      meta: { title: 'Full Report', description: 'Test desc', techStackDetected: ['React', 'Node.js'] },
      seo: { h1Count: 1, h2Count: 4, internalLinks: 20, externalLinks: 5, imagesCount: 12 },
      _meta: {
        html: { source: 'browser', length: 50000, primary_h1: 'Welcome' },
      },
    });
    const result = buildAiSeedSignals(baseDomain, report);
    expect(result).toEqual({
      title: 'Full Report',
      description: 'Test desc',
      techStackDetected: ['React', 'Node.js'],
      h1Count: 1,
      h2Count: 4,
      internalLinks: 20,
      externalLinks: 5,
      imagesCount: 12,
      primaryH1: 'Welcome',
      contentLength: 50000,
    });
  });

  it('falls back to domain when title is empty', () => {
    const report = makeReport({
      seo: { h1Count: 1 },
    });
    const result = buildAiSeedSignals(baseDomain, report);
    expect(result!.title).toBe(baseDomain);
  });

  it('filters empty strings from techStackDetected', () => {
    const report = makeReport({
      meta: { title: 'Test', description: '', techStackDetected: ['React', '', '  ', 'Vue'] },
    });
    const result = buildAiSeedSignals(baseDomain, report);
    expect(result!.techStackDetected).toEqual(['React', 'Vue']);
  });

  it('trims and de-duplicates techStackDetected entries', () => {
    const report = makeReport({
      meta: { title: 'Test', description: '', techStackDetected: [' React ', 'Vue', 'React', '  Vue '] },
    });
    const result = buildAiSeedSignals(baseDomain, report);
    expect(result!.techStackDetected).toEqual(['React', 'Vue']);
  });

  it('handles contentLength from _meta.html.length', () => {
    const report = makeReport({
      _meta: { html: { length: 12345 } },
    });
    const result = buildAiSeedSignals(baseDomain, report);
    expect(result).toBeDefined();
    expect(result!.contentLength).toBe(12345);
  });

  it('trims title and description whitespace', () => {
    const report = makeReport({
      meta: { title: '  Padded Title  ', description: '  Padded Desc  ', techStackDetected: [] },
    });
    const result = buildAiSeedSignals(baseDomain, report);
    expect(result!.title).toBe('Padded Title');
    expect(result!.description).toBe('Padded Desc');
  });

  it('normalizes invalid numeric counters and still uses primary h1 as signal', () => {
    const report = makeReport({
      seo: {
        h1Count: -1,
        h2Count: Number.NaN,
        internalLinks: Number.POSITIVE_INFINITY,
        externalLinks: -10,
        imagesCount: -3,
      },
      _meta: {
        html: {
          length: -100,
          primary_h1: '  Hero  ',
        },
      },
    });
    const result = buildAiSeedSignals(baseDomain, report);
    expect(result).toBeDefined();
    expect(result).toMatchObject({
      title: baseDomain,
      h1Count: 0,
      h2Count: 0,
      internalLinks: 0,
      externalLinks: 0,
      imagesCount: 0,
      contentLength: 0,
      primaryH1: 'Hero',
    });
  });
});
