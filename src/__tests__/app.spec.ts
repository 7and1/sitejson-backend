import { afterEach, describe, expect, it } from 'vitest';
import { resolvePgPoolMax } from '../app.js';
import { loadEnv } from '../config/env.js';

const ORIGINAL_ENV = { ...process.env };

describe('resolvePgPoolMax', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('uses role-based defaults when no pool env vars are set', () => {
    delete process.env.PG_POOL_MAX;
    delete process.env.PG_POOL_MAX_API;
    delete process.env.PG_POOL_MAX_WORKER;

    const env = loadEnv();

    expect(resolvePgPoolMax(env, 'api', {})).toBe(20);
    expect(resolvePgPoolMax(env, 'worker', {})).toBe(50);
  });

  it('prefers role-specific overrides before the legacy shared fallback', () => {
    process.env.PG_POOL_MAX = '15';
    process.env.PG_POOL_MAX_API = '24';
    process.env.PG_POOL_MAX_WORKER = '48';

    const env = loadEnv();

    expect(resolvePgPoolMax(env, 'api', process.env)).toBe(24);
    expect(resolvePgPoolMax(env, 'worker', process.env)).toBe(48);
  });

  it('falls back to the legacy shared pool max when only PG_POOL_MAX is set', () => {
    process.env.PG_POOL_MAX = '18';
    delete process.env.PG_POOL_MAX_API;
    delete process.env.PG_POOL_MAX_WORKER;

    const env = loadEnv();

    expect(resolvePgPoolMax(env, 'api', process.env)).toBe(18);
    expect(resolvePgPoolMax(env, 'worker', process.env)).toBe(18);
  });
});
