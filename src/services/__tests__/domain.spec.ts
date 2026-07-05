import { describe, expect, it } from 'vitest';
import { normalizeDomain } from '../domain.js';

describe('normalizeDomain', () => {
  it('normalizes valid domains', () => {
    expect(normalizeDomain('Example.COM')).toBe('example.com');
    expect(normalizeDomain('https://Sub.Example.COM./path?q=1')).toBe('sub.example.com');
    expect(normalizeDomain('Bücher.de')).toBe('xn--bcher-kva.de');
    expect(normalizeDomain('例え.テスト')).toBe('xn--r8jz45g.xn--zckzah');
    expect(normalizeDomain('XN--BCHER-KVA.DE')).toBe('xn--bcher-kva.de');
  });

  it('throws for invalid domains', () => {
    expect(() => normalizeDomain('not_a_domain')).toThrowError('INVALID_DOMAIN');
    expect(() => normalizeDomain('-invalid.com')).toThrowError('INVALID_DOMAIN');
    expect(() => normalizeDomain('..bad.com')).toThrowError('INVALID_DOMAIN');
    expect(() => normalizeDomain('example.com/path')).toThrowError('INVALID_DOMAIN');
    expect(() => normalizeDomain('user@example.com')).toThrowError('INVALID_DOMAIN');
    expect(() => normalizeDomain('example.com:443')).toThrowError('INVALID_DOMAIN');
    expect(() => normalizeDomain('127.0.0.1')).toThrowError('INVALID_DOMAIN');
    expect(() => normalizeDomain('[::1]')).toThrowError('INVALID_DOMAIN');
  });
});
