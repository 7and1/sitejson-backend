import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiSpec } from '../src/api/openapi.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(scriptDir, '..');
const targetPath = path.resolve(backendDir, '../docs/openapi.v1.json');

const expected = `${JSON.stringify(buildOpenApiSpec(), null, 2)}\n`;

let actual: string;
try {
  actual = await readFile(targetPath, 'utf8');
} catch {
  console.error(`[openapi] missing file: ${targetPath}`);
  console.error('[openapi] run: npm run openapi:export');
  process.exit(1);
}

if (actual !== expected) {
  console.error(`[openapi] drift detected: ${targetPath}`);
  console.error('[openapi] run: npm run openapi:export');
  process.exit(1);
}

console.log('[openapi] check passed');
