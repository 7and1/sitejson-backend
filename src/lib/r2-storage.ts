import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY || '';
const R2_SECRET_KEY = process.env.R2_SECRET_KEY || '';
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'sitejson-assets';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

// Lazy init to avoid errors when env vars not set
let r2Client: S3Client | null = null;

function getR2Client(): S3Client {
  if (!r2Client) {
    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY || !R2_SECRET_KEY) {
      throw new Error('R2 credentials not configured');
    }
    r2Client = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY,
        secretAccessKey: R2_SECRET_KEY,
      },
    });
  }
  return r2Client;
}

/**
 * Sanitize domain to safe filename
 * google.com -> google_com
 */
function domainToKey(domain: string): string {
  return domain.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

export const R2Storage = {
  /**
   * Upload screenshot (always overwrites existing)
   */
  async uploadScreenshot(domain: string, buffer: Buffer): Promise<string> {
    const client = getR2Client();
    const fileName = `snapshots/${domainToKey(domain)}.webp`;

    await client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: fileName,
      Body: buffer,
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=3600, s-maxage=86400',
    }));

    return `${R2_PUBLIC_URL}/${fileName}`;
  },

  /**
   * Upload only if content changed (saves R2 Class A ops)
   */
  async uploadScreenshotIfChanged(domain: string, buffer: Buffer): Promise<string> {
    const client = getR2Client();
    const fileName = `snapshots/${domainToKey(domain)}.webp`;
    const newHash = crypto.createHash('md5').update(buffer).digest('hex');

    try {
      const head = await client.send(new HeadObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: fileName,
      }));

      const existingHash = head.ETag?.replace(/"/g, '');
      if (existingHash === newHash) {
        return `${R2_PUBLIC_URL}/${fileName}`;
      }
    } catch {
      // File doesn't exist, continue to upload
    }

    await client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: fileName,
      Body: buffer,
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=3600, s-maxage=86400',
    }));

    return `${R2_PUBLIC_URL}/${fileName}`;
  },

  /**
   * Check if R2 is configured
   */
  isConfigured(): boolean {
    return !!(R2_ACCOUNT_ID && R2_ACCESS_KEY && R2_SECRET_KEY && R2_PUBLIC_URL);
  },
};
