/**
 * Seed script for SiteJSON - loads Top N domains from Tranco list
 * Usage: npx tsx scripts/seed.ts [--limit=1000] [--delay=100] [--dry-run]
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const API_BASE = process.env.SITEJSON_API_URL || 'http://127.0.0.1:8787';
const API_KEY = process.env.SITEJSON_API_KEY || 'dev-api-key';
const CSV_FILE = process.env.CSV_FILE || './top-1m.csv';

interface SeedOptions {
  limit: number;
  delayMs: number;
  dryRun: boolean;
  startFrom: number;
}

const parseArgs = (): SeedOptions => {
  const args = process.argv.slice(2);
  const options: SeedOptions = {
    limit: 1000,
    delayMs: 100,
    dryRun: false,
    startFrom: 1,
  };

  for (const arg of args) {
    if (arg.startsWith('--limit=')) {
      options.limit = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--delay=')) {
      options.delayMs = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--start=')) {
      options.startFrom = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }

  return options;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const submitDomain = async (domain: string, rank: number): Promise<{ ok: boolean; reason?: string }> => {
  try {
    const response = await fetch(`${API_BASE}/api/v1/sites/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        domain,
        priority: rank <= 100 ? 'high' : 'normal',
        force_refresh: false,
        force_ai: false,
      }),
    });

    const data = (await response.json()) as { ok: boolean; data?: { reason?: string }; error?: { code?: string } };

    if (response.status === 202 || response.status === 200) {
      return { ok: true, reason: data.data?.reason };
    } else if (response.status === 409) {
      return { ok: true, reason: 'JOB_ALREADY_RUNNING' };
    } else {
      return { ok: false, reason: data.error?.code || `HTTP ${response.status}` };
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Unknown error' };
  }
};

const main = async () => {
  const options = parseArgs();

  console.log('='.repeat(60));
  console.log('SiteJSON Seed Script');
  console.log('='.repeat(60));
  console.log(`API: ${API_BASE}`);
  console.log(`CSV: ${CSV_FILE}`);
  console.log(`Limit: ${options.limit} domains`);
  console.log(`Start from rank: ${options.startFrom}`);
  console.log(`Delay: ${options.delayMs}ms between requests`);
  console.log(`Dry run: ${options.dryRun}`);
  console.log('='.repeat(60));

  const rl = createInterface({
    input: createReadStream(CSV_FILE),
    crlfDelay: Infinity,
  });

  let processed = 0;
  let queued = 0;
  let skipped = 0;
  let errors = 0;
  let alreadyFresh = 0;

  const startTime = Date.now();

  for await (const line of rl) {
    const [rankStr, domain] = line.split(',');
    const rank = parseInt(rankStr, 10);

    if (!domain || !rank) continue;
    if (rank < options.startFrom) continue;
    if (processed >= options.limit) break;

    processed++;

    if (options.dryRun) {
      console.log(`[DRY] #${rank} ${domain}`);
      continue;
    }

    const result = await submitDomain(domain, rank);

    if (result.ok) {
      if (result.reason === 'QUEUED') {
        queued++;
        console.log(`[QUEUED] #${rank} ${domain}`);
      } else if (result.reason === 'ALREADY_FRESH') {
        alreadyFresh++;
        if (processed % 100 === 0) {
          console.log(`[FRESH] #${rank} ${domain} (${alreadyFresh} fresh so far)`);
        }
      } else if (result.reason === 'JOB_ALREADY_RUNNING') {
        skipped++;
      } else {
        queued++;
        console.log(`[OK] #${rank} ${domain} - ${result.reason}`);
      }
    } else {
      errors++;
      console.error(`[ERROR] #${rank} ${domain} - ${result.reason}`);
    }

    // Progress report every 100 domains
    if (processed % 100 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (processed / parseFloat(elapsed)).toFixed(1);
      console.log(`--- Progress: ${processed}/${options.limit} (${rate}/s) | Queued: ${queued} | Fresh: ${alreadyFresh} | Errors: ${errors} ---`);
    }

    if (options.delayMs > 0) {
      await sleep(options.delayMs);
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n' + '='.repeat(60));
  console.log('Seed Complete!');
  console.log('='.repeat(60));
  console.log(`Total processed: ${processed}`);
  console.log(`Queued for analysis: ${queued}`);
  console.log(`Already fresh: ${alreadyFresh}`);
  console.log(`Skipped (running): ${skipped}`);
  console.log(`Errors: ${errors}`);
  console.log(`Time: ${totalTime}s`);
  console.log('='.repeat(60));
};

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
