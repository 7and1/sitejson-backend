#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, '..');
const parentScanner = path.resolve(backendRoot, '../scripts/secret-scan.mjs');

if (fs.existsSync(parentScanner)) {
  const result = spawnSync(process.execPath, [parentScanner, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

const args = new Set(process.argv.slice(2));

const readScope = () => {
  const index = process.argv.indexOf('--scope');
  if (index >= 0) {
    return process.argv[index + 1] ?? 'backend';
  }
  return args.has('--all') ? 'all' : 'backend';
};

const scopes = {
  backend: [
    'src',
    'scripts',
    'docs',
    '.env.example',
    'Dockerfile',
    'Dockerfile.overlay',
    'package.json',
  ],
  all: [
    'src',
    'scripts',
    'docs',
    '.env.example',
    'Dockerfile',
    'Dockerfile.overlay',
    'package.json',
  ],
};

const scope = readScope();
const roots = scopes[scope] ?? scopes.backend;

const ignoredDirectories = new Set([
  '.git',
  '.github',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);

const ignoredExtensions = new Set([
  '.avif',
  '.csv',
  '.gif',
  '.ico',
  '.jpg',
  '.jpeg',
  '.lock',
  '.pdf',
  '.png',
  '.webp',
  '.zip',
]);

const allowedValueFragments = [
  '<',
  '...',
  'change-me',
  'dummy',
  'example',
  'fake',
  'fixture',
  'placeholder',
  'process.env',
  'replace_me',
  'replace_with',
  'sample',
  'test-',
  'your_',
  'postgres',
];

const patterns = [
  {
    kind: 'secret-assignment',
    regex: /\b(api[_-]?key|client[_-]?secret|password|proxy[_-]?password|secret|token)\b\s*[:=]\s*['"]([^'"\n]{8,})['"]/gi,
    valueGroup: 2,
  },
  {
    kind: 'env-secret-assignment',
    regex: /\b[A-Z0-9_]*(?:API_KEY|CLIENT_SECRET|PASSWORD|SECRET|TOKEN)\b\s*=\s*([^\s#'"]{12,})/g,
    valueGroup: 1,
  },
  {
    kind: 'publisher-radar-key',
    regex: /\bpr_[A-Za-z0-9]{20,}\b/g,
  },
  {
    kind: 'proxy-credential-url',
    regex: /\b[A-Za-z0-9._~%+-]{3,}:[A-Za-z0-9._~%!$&'()*+,;=-]{8,}@[\w.-]+:\d{2,5}\b/g,
  },
  {
    kind: 'proxy-credential-tuple',
    regex: /\b[\w.-]+:\d{2,5}:[A-Za-z0-9._~%+-]{3,}:[A-Za-z0-9._~%!$&'()*+,;=-]{8,}\b/g,
  },
];

const isAllowedValue = (value) => {
  const normalized = value.toLowerCase();
  return allowedValueFragments.some((fragment) => normalized.includes(fragment));
};

const shouldSkipPath = (absolutePath) => {
  const relativePath = path.relative(backendRoot, absolutePath);
  const segments = relativePath.split(path.sep);
  if (segments.some((segment) => ignoredDirectories.has(segment))) {
    return true;
  }
  if (relativePath.endsWith('package-lock.json') || relativePath.endsWith('pnpm-lock.yaml')) {
    return true;
  }
  if (relativePath.includes('__tests__') || /\.test\.[cm]?[tj]sx?$/.test(relativePath)) {
    return true;
  }
  return ignoredExtensions.has(path.extname(relativePath).toLowerCase());
};

const walk = (absolutePath, files) => {
  if (!fs.existsSync(absolutePath) || shouldSkipPath(absolutePath)) {
    return files;
  }

  const stat = fs.statSync(absolutePath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(absolutePath)) {
      walk(path.join(absolutePath, entry), files);
    }
    return files;
  }

  if (stat.isFile()) {
    files.push(absolutePath);
  }
  return files;
};

const findings = [];
const files = roots.flatMap((root) => walk(path.join(backendRoot, root), []));

for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(line)) !== null) {
        const value = pattern.valueGroup ? match[pattern.valueGroup] : match[0];
        if (isAllowedValue(value)) {
          continue;
        }
        findings.push({
          file: path.relative(backendRoot, file),
          line: index + 1,
          kind: pattern.kind,
        });
      }
    }
  });
}

if (findings.length > 0) {
  console.error(`Secret scan failed: ${findings.length} potential secret pattern(s). Values are intentionally redacted.`);
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} ${finding.kind}`);
  }
  process.exit(1);
}

console.log(`Secret scan passed (${scope}, ${files.length} files scanned).`);
