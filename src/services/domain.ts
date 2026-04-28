import { z } from 'zod';
import { getDomain } from 'tldts';

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

export const normalizeDomain = (input: string): string => {
  const parsed = asciiDomainSchema.safeParse(input);
  if (!parsed.success) {
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
