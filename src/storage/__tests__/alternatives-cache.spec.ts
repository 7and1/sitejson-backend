import { describe, expect, it } from 'vitest';
import {
  ALTERNATIVES_CACHE_ALGORITHM_VERSION,
  computeAlternativesQualityScore,
  createAlternativesCacheExpiry,
  parseAlternativesCachePayload,
} from '../alternatives-cache.js';

describe('alternatives durable cache helpers', () => {
  it('uses a versioned rule-based cache key', () => {
    expect(ALTERNATIVES_CACHE_ALGORITHM_VERSION).toBe('rule_based:v1');
  });

  it('normalizes cached item payloads and enforces the requested limit', () => {
    const parsed = parseAlternativesCachePayload([
      { domain: 'ALT.COM', title: ' Alt ', rank: 1200, score: 0.91, reasons: ['same_category'] },
      { domain: '', title: 'Missing domain', rank: 1, score: 1 },
      { domain: 'third.com', title: '', rank: Number.NaN, score: 2, reasons: [1, 'shared_tech_stack'] },
    ], 1);

    expect(parsed).toEqual({
      algorithm: 'rule_based',
      items: [
        { domain: 'alt.com', title: 'Alt', rank: 1200, score: 0.91, reasons: ['same_category'] },
      ],
    });
  });

  it('rejects non-array cached payloads', () => {
    expect(parseAlternativesCachePayload({ items: [] }, 6)).toBeNull();
  });

  it('computes a bounded quality score from result items', () => {
    expect(computeAlternativesQualityScore({
      algorithm: 'rule_based',
      items: [
        { domain: 'a.com', title: 'A', rank: 1, score: 0.4, reasons: [] },
        { domain: 'b.com', title: 'B', rank: 2, score: 1.2, reasons: [] },
      ],
    })).toBe(0.7);
  });

  it('creates a future durable expiry timestamp', () => {
    expect(new Date(createAlternativesCacheExpiry(0)).getTime()).toBeGreaterThan(0);
  });
});
