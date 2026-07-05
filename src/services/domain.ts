import { z } from 'zod';
import { getDomain } from 'tldts';
import { domainToASCII } from 'node:url';
import { isIpv4Literal } from './network-safety.js';

const asciiDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine((value) => !value.startsWith('.'), 'invalid domain format')
  .refine((value) => !value.endsWith('.'), 'invalid domain format')
  .refine((value) => !value.includes('..'), 'invalid domain format')
  .refine((value) => value.split('.').every((label) => label.length > 0 && label.length <= 63), 'invalid domain format')
  .refine((value) => value.split('.').every((label) => !label.startsWith('-') && !label.endsWith('-')), 'invalid domain format')
  .refine((value) => /^[a-z0-9.-]+$/.test(value), 'invalid domain format');

const extractHostname = (input: string): string => {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error('INVALID_DOMAIN');
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname;
    } catch {
      throw new Error('INVALID_DOMAIN');
    }
  }

  return trimmed;
};

const canonicalizeToAsciiDomain = (input: string): string => {
  const hostname = extractHostname(input).replace(/\.$/u, '');
  if (hostname.length === 0 || hostname.includes('/') || hostname.includes('@') || hostname.includes(':')) {
    throw new Error('INVALID_DOMAIN');
  }

  const ascii = domainToASCII(hostname);
  if (!ascii) {
    throw new Error('INVALID_DOMAIN');
  }

  return ascii.toLowerCase();
};

export const normalizeDomain = (input: string): string => {
  const canonical = canonicalizeToAsciiDomain(input);
  const parsed = asciiDomainSchema.safeParse(canonical);
  if (!parsed.success) {
    throw new Error('INVALID_DOMAIN');
  }

  if (isIpv4Literal(parsed.data)) {
    throw new Error('INVALID_DOMAIN');
  }

  const registrable = getDomain(parsed.data, { detectIp: true, allowPrivateDomains: false });
  if (!registrable) {
    throw new Error('INVALID_DOMAIN');
  }

  if (parsed.data === registrable || parsed.data.endsWith(`.${registrable}`)) {
    return parsed.data;
  }

  throw new Error('INVALID_DOMAIN');
};
