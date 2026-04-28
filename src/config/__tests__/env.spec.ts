import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../env.js';

const ORIGINAL_ENV = { ...process.env };

describe('loadEnv', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('allows the development default api key outside production', () => {
    delete process.env.NODE_ENV;
    delete process.env.SITEJSON_API_KEY;

    const env = loadEnv();

    expect(env.NODE_ENV).toBe('development');
    expect(env.SITEJSON_API_KEY).toBe('dev-api-key');
  });

  it('rejects a missing production api key', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SITEJSON_API_KEY;

    expect(() => loadEnv()).toThrow(/SITEJSON_API_KEY must be explicitly configured for production/);
  });

  it('rejects placeholder production api keys', () => {
    process.env.NODE_ENV = 'production';
    process.env.SITEJSON_API_KEY = 'prod-api-key-change-me';

    expect(() => loadEnv()).toThrow(/SITEJSON_API_KEY must be explicitly configured for production/);
  });

  it('accepts an explicit production api key', () => {
    process.env.NODE_ENV = 'production';
    process.env.SITEJSON_API_KEY = 'sitejson-prod-key-123';

    const env = loadEnv();

    expect(env.NODE_ENV).toBe('production');
    expect(env.SITEJSON_API_KEY).toBe('sitejson-prod-key-123');
  });

  it('accepts an optional previous production api key for rotation', () => {
    process.env.NODE_ENV = 'production';
    process.env.SITEJSON_API_KEY = 'sitejson-prod-key-123';
    process.env.SITEJSON_API_KEY_PREVIOUS = 'prod-api-key-change-me';

    const env = loadEnv();

    expect(env.SITEJSON_API_KEY).toBe('sitejson-prod-key-123');
    expect(env.SITEJSON_API_KEY_PREVIOUS).toBe('prod-api-key-change-me');
  });
});
