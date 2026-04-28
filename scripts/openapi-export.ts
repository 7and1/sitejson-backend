import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiSpec } from '../src/api/openapi.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(scriptDir, '..');
const outputPath = path.resolve(backendDir, '../docs/openapi.v1.json');

const spec = buildOpenApiSpec();
const content = `${JSON.stringify(spec, null, 2)}\n`;

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, content, 'utf8');

console.log(`[openapi] exported: ${outputPath}`);
