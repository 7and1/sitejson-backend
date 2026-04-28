import { describe, expect, it } from 'vitest';
import { normalizeDomain } from '../domain.js';

describe('normalizeDomain', () => {
  it('normalizes valid domains', () => {
    expect(normalizeDomain('Example.COM')).toBe('example.com');
  });

  it('throws for invalid domains', () => {
    expect(() => normalizeDomain('not_a_domain')).toThrowError('INVALID_DOMAIN');
    expect(() => normalizeDomain('-invalid.com')).toThrowError('INVALID_DOMAIN');
    expect(() => normalizeDomain('..bad.com')).toThrowError('INVALID_DOMAIN');
  });
});
