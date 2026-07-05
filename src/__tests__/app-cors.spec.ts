import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

const ORIGINAL_ENV = { ...process.env };
const STRONG_API_KEY = 'sj_live_A7x9Qp2Lm8R4tY6uI0oP3zX5cV1bN9mK';
const STRONG_OPS_KEY = 'sj_ops_Z4pL8nQ2vR7sT1xC6mB9yH3kD5wF0aJ';

const configureProductionEnv = (corsAllowlist: string) => {
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'production',
    STORAGE_DRIVER: 'memory',
    QUEUE_DRIVER: 'memory',
    SITEJSON_API_KEY: STRONG_API_KEY,
    SITEJSON_OPS_API_KEY: STRONG_OPS_KEY,
    CORS_ALLOWLIST: corsAllowlist,
    BROWSER_ENABLED: 'false',
  };
  delete process.env.SITEJSON_API_KEY_PREVIOUS;
  delete process.env.SITEJSON_OPS_API_KEY_PREVIOUS;
};

describe('buildApp CORS policy', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('sets CORS headers only for production allowlist origins', async () => {
    configureProductionEnv('https://sitejson.com,https://app.sitejson.com');

    const runtime = await buildApp();
    try {
      const allowed = await runtime.app.inject({
        method: 'GET',
        url: '/api/v1/healthz',
        headers: {
          origin: 'https://app.sitejson.com',
        },
      });

      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers['access-control-allow-origin']).toBe('https://app.sitejson.com');
      expect(allowed.headers.vary).toBe('Origin');

      const blocked = await runtime.app.inject({
        method: 'GET',
        url: '/api/v1/healthz',
        headers: {
          origin: 'https://evil.example',
        },
      });

      expect(blocked.statusCode).toBe(200);
      expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
      expect(blocked.headers.vary).toBe('Origin');
    } finally {
      await runtime.close();
      await runtime.app.close();
    }
  });
});
