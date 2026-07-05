import { mkdtemp, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ScreenshotStorage } from '../screenshot-storage.js';

const makeTempDir = () => mkdtemp(path.join(tmpdir(), 'sitejson-screenshot-storage-'));

describe('ScreenshotStorage', () => {
  it('stores local screenshots as webp and returns the public snapshot URL when configured', async () => {
    const localDir = await makeTempDir();
    const storage = new ScreenshotStorage({
      mode: 'local',
      localDir,
      publicBaseUrl: 'https://api.sitejson.com/',
    });

    const result = await storage.save('Example-Site.com', Buffer.from('webp-bytes'));

    expect(result.storage).toBe('local');
    expect(result.screenshotPath).toBe(path.join(localDir, 'example_site_com.webp'));
    expect(result.screenshotUrl).toBe('https://api.sitejson.com/snapshots/example_site_com.webp');
    expect((await stat(result.screenshotPath ?? '')).isFile()).toBe(true);
  });

  it('omits the public snapshot URL when local public base URL is empty', async () => {
    const localDir = await makeTempDir();
    const storage = new ScreenshotStorage({
      mode: 'local',
      localDir,
      publicBaseUrl: '',
    });

    const result = await storage.save('example.com', Buffer.from('webp-bytes'));

    expect(result.screenshotPath).toBe(path.join(localDir, 'example_com.webp'));
    expect(result.screenshotUrl).toBeUndefined();
  });
});
