import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { R2Storage } from './r2-storage.js';

export type ScreenshotStorageMode = 'local' | 'r2';

export interface ScreenshotStorageConfig {
  mode: ScreenshotStorageMode;
  localDir: string;
}

const sanitizeDomain = (domain: string): string => domain.toLowerCase().replace(/[^a-z0-9]/g, '_');

export class ScreenshotStorage {
  constructor(private readonly config: ScreenshotStorageConfig) {}

  async save(domain: string, buffer: Buffer): Promise<{
    storage: ScreenshotStorageMode;
    screenshotUrl?: string;
    screenshotPath?: string;
  }> {
    if (this.config.mode === 'r2' && R2Storage.isConfigured()) {
      const screenshotUrl = await R2Storage.uploadScreenshotIfChanged(domain, buffer);
      return {
        storage: 'r2',
        screenshotUrl,
      };
    }

    await mkdir(this.config.localDir, { recursive: true });
    const filename = `${sanitizeDomain(domain)}.png`;
    const filepath = path.join(this.config.localDir, filename);
    await writeFile(filepath, buffer);

    return {
      storage: 'local',
      screenshotPath: filepath,
    };
  }
}
