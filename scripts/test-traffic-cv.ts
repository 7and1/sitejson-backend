/**
 * Test script: Verify Playwright can fetch traffic.cv data
 * Usage: npx tsx scripts/test-traffic-cv.ts [domain]
 */
import { chromium } from 'playwright';

const TEST_DOMAIN = process.argv[2] || 'google.com';
const TARGET_URL = `https://traffic.cv/${encodeURIComponent(TEST_DOMAIN)}`;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithPlaywright(url: string): Promise<{ success: boolean; html: string | null; error?: string }> {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--window-size=1920,1080',
      '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ],
  });

  // Inject stealth script to hide automation
  const stealthScript = `
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
    delete navigator.__proto__.webdriver;
  `;

  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
    });

    const page = await context.newPage();

    // Inject stealth script
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      // @ts-expect-error - chrome is not defined
      window.chrome = { runtime: {} };
      // @ts-expect-error - webdriver is on prototype
      delete navigator.__proto__.webdriver;
    });

    // Block heavy resources
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'font' || type === 'media' || type === 'image') {
        return route.abort();
      }
      return route.continue();
    });

    console.log(`[1/4] Navigating to ${url}...`);
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    console.log(`[2/4] Response status: ${response?.status()}`);

    // Wait longer for challenge to complete
    console.log('[3/4] Waiting for page to stabilize (max 15s)...');
    try {
      // Wait for network idle or specific selector
      await Promise.race([
        page.waitForLoadState('networkidle', { timeout: 15000 }),
        page.waitForSelector('[data-rank]', { timeout: 15000 }).catch(() => {}),
      ]);
    } catch {
      // Timeout is ok, continue
    }

    // Check if we hit a challenge page
    const title = await page.title().catch(() => 'no-title');
    console.log(`[4/4] Page title: ${title}`);

    const html = await page.content();

    // Check for block indicators
    if (html.includes('Just a moment') || html.includes('cf-chl') || html.includes('challenge')) {
      return { success: false, html: null, error: 'Cloudflare challenge page detected' };
    }

    // Check for traffic data
    const hasData = html.includes('monthlyVisits') || html.includes('globalRank') || html.includes('trafficData');
    if (!hasData) {
      return { success: false, html: html.slice(0, 2000), error: 'No traffic data found in response' };
    }

    return { success: true, html };
  } catch (err) {
    return { success: false, html: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  console.log(`\n=== Testing traffic.cv fetch for: ${TEST_DOMAIN} ===\n`);

  const startTime = Date.now();
  const result = await fetchWithPlaywright(TARGET_URL);
  const elapsed = Date.now() - startTime;

  console.log(`\n=== Result (${elapsed}ms) ===`);
  console.log(`Success: ${result.success}`);

  if (result.error) {
    console.log(`Error: ${result.error}`);
  }

  if (result.html) {
    console.log(`\nHTML preview (first 3000 chars):`);
    console.log(result.html.slice(0, 3000));
  }

  process.exit(result.success ? 0 : 1);
}

main();
