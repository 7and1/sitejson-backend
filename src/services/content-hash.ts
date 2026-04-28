import { createHash } from 'node:crypto';

const normalize = (value: string | undefined): string => {
  return (value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
};

const toLengthBucket = (contentLength?: number): string => {
  if (!contentLength || !Number.isFinite(contentLength) || contentLength <= 0) {
    return 'len:0';
  }

  if (contentLength < 1000) {
    return 'len:<1k';
  }

  if (contentLength < 5000) {
    return 'len:1k-5k';
  }

  if (contentLength < 15000) {
    return 'len:5k-15k';
  }

  if (contentLength < 50000) {
    return 'len:15k-50k';
  }

  return 'len:50k+';
};

export const computeContentHash = (input: {
  title?: string;
  description?: string;
  primaryH1?: string;
  contentLength?: number;
}): string | null => {
  const normalizedTitle = normalize(input.title);
  const normalizedDescription = normalize(input.description);
  const normalizedH1 = normalize(input.primaryH1);
  const lengthBucket = toLengthBucket(input.contentLength);

  if (!normalizedTitle && !normalizedDescription && !normalizedH1) {
    return null;
  }

  const payload = [normalizedTitle, normalizedDescription, normalizedH1, lengthBucket].join('\n');
  return createHash('sha256').update(payload).digest('hex');
};
