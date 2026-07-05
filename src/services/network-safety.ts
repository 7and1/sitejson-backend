import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

const parseIpv4 = (value: string): number[] | null => {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return null;
  }

  const bytes = parts.map((part) => Number.parseInt(part, 10));
  if (bytes.some((byte, index) => !/^\d{1,3}$/.test(parts[index]) || byte < 0 || byte > 255)) {
    return null;
  }

  return bytes;
};

export const isIpv4Literal = (value: string): boolean => parseIpv4(value) !== null;

const isBlockedIpv4 = (value: string): boolean => {
  const bytes = parseIpv4(value);
  if (!bytes) {
    return false;
  }

  const [a, b] = bytes;
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 192 && b === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51)
    || (a === 203 && b === 0)
    || a >= 224
  );
};

const isBlockedIpv6 = (value: string): boolean => {
  const normalized = value.toLowerCase();
  if (normalized === '::' || normalized === '::1') {
    return true;
  }

  if (normalized.startsWith('::ffff:')) {
    return isBlockedIpv4(normalized.slice('::ffff:'.length));
  }

  const firstSegment = normalized.split(':', 1)[0] ?? '';
  const first = Number.parseInt(firstSegment || '0', 16);
  if (!Number.isFinite(first)) {
    return true;
  }

  return (
    (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xff00) === 0xff00
  );
};

export const isBlockedIpAddress = (value: string): boolean => {
  const kind = isIP(value);
  if (kind === 4) {
    return isBlockedIpv4(value);
  }
  if (kind === 6) {
    return isBlockedIpv6(value);
  }
  return false;
};

export const resolvePublicAddresses = async (hostname: string): Promise<string[]> => {
  const literalKind = isIP(hostname);
  if (literalKind !== 0) {
    if (isBlockedIpAddress(hostname)) {
      throw new Error('SSRF_BLOCKED_IP');
    }
    return [hostname];
  }

  const [v4Result, v6Result] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);

  const addresses = [
    ...(v4Result.status === 'fulfilled' ? v4Result.value : []),
    ...(v6Result.status === 'fulfilled' ? v6Result.value : []),
  ];

  if (addresses.length === 0) {
    throw new Error('DNS_NOT_RESOLVED');
  }

  const blocked = addresses.find(isBlockedIpAddress);
  if (blocked) {
    throw new Error(`DNS_BLOCKED_PRIVATE_ADDRESS:${blocked}`);
  }

  return addresses;
};
