import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiSpec } from '../src/api/openapi.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(scriptDir, '..');

const resolveOpenApiPath = () => {
  if (process.env.SITEJSON_OPENAPI_PATH) {
    return path.resolve(backendDir, process.env.SITEJSON_OPENAPI_PATH);
  }

  const sharedDocsPath = path.resolve(backendDir, '../docs/openapi.v1.json');
  if (process.env.GITHUB_ACTIONS !== 'true') {
    return sharedDocsPath;
  }

  return path.resolve(backendDir, 'docs/openapi.v1.json');
};

const targetPath = resolveOpenApiPath();

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
