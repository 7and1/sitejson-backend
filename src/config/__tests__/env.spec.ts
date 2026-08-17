import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../env.js';

const ORIGINAL_ENV = { ...process.env };
const STRONG_API_KEY = 'sj_live_A7x9Qp2Lm8R4_tY6uI0oP3zX5cV1bN9mK';
const STRONG_OPS_KEY = 'sj_ops_Z4pL8nQ2vR7sT1xC6mB9yH3kD5wF0aJ';
const STRONG_PREVIOUS_API_KEY = 'sj_prev_B8qN3vT6mX1cZ9pL4rS7kD2hW5yF0uE';
const STRONG_PREVIOUS_OPS_KEY = 'sj_ops_prev_C5rT9xM2pL7vN4qB8zK1hD6wY3sF0eA';
const PRODUCTION_CORS_ALLOWLIST = 'https://sitejson.com,https://www.sitejson.com';

describe('loadEnv', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('allows the development default api key outside production', () => {
    delete process.env.NODE_ENV;
    delete process.env.SITEJSON_API_KEY;
    delete process.env.SITEJSON_OPS_API_KEY;

    const env = loadEnv();

    expect(env.NODE_ENV).toBe('development');
    expect(env.SITEJSON_API_KEY).toBe('dev-api-key');
    expect(env.SITEJSON_OPS_API_KEY).toBe('dev-ops-api-key');
  });

  it('rejects a missing production api key', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SITEJSON_API_KEY;
    process.env.SITEJSON_OPS_API_KEY = STRONG_OPS_KEY;
    process.env.CORS_ALLOWLIST = PRODUCTION_CORS_ALLOWLIST;

    expect(() => loadEnv()).toThrow(/SITEJSON_API_KEY must be at least 32 characters and high entropy/);
  });

  it('rejects placeholder production api keys', () => {
    process.env.NODE_ENV = 'production';
    process.env.SITEJSON_API_KEY = 'prod-api-key-change-me';
    process.env.SITEJSON_OPS_API_KEY = STRONG_OPS_KEY;
    process.env.CORS_ALLOWLIST = PRODUCTION_CORS_ALLOWLIST;

    expect(() => loadEnv()).toThrow(/SITEJSON_API_KEY must be at least 32 characters and high entropy/);
  });

  it('rejects low-entropy production api keys', () => {
    process.env.NODE_ENV = 'production';
    process.env.SITEJSON_API_KEY = 'aaaaaaaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaa';
    process.env.SITEJSON_OPS_API_KEY = STRONG_OPS_KEY;
    process.env.CORS_ALLOWLIST = PRODUCTION_CORS_ALLOWLIST;

    expect(() => loadEnv()).toThrow(/SITEJSON_API_KEY must be at least 32 characters and high entropy/);
  });

  it('rejects a missing production ops api key', () => {
    process.env.NODE_ENV = 'production';
    process.env.SITEJSON_API_KEY = STRONG_API_KEY;
    delete process.env.SITEJSON_OPS_API_KEY;
    process.env.CORS_ALLOWLIST = PRODUCTION_CORS_ALLOWLIST;

    expect(() => loadEnv()).toThrow(/SITEJSON_OPS_API_KEY must be at least 32 characters and high entropy/);
  });

  it('rejects wildcard production CORS allowlist', () => {
    process.env.NODE_ENV = 'production';
    process.env.SITEJSON_API_KEY = STRONG_API_KEY;
    process.env.SITEJSON_OPS_API_KEY = STRONG_OPS_KEY;
    process.env.CORS_ALLOWLIST = '*';

    expect(() => loadEnv()).toThrow(/CORS_ALLOWLIST must be an explicit origin allowlist in production/);
  });

  it('rejects production CORS origins with paths', () => {
    process.env.NODE_ENV = 'production';
    process.env.SITEJSON_API_KEY = STRONG_API_KEY;
    process.env.SITEJSON_OPS_API_KEY = STRONG_OPS_KEY;
    process.env.CORS_ALLOWLIST = 'https://sitejson.com/app';

    expect(() => loadEnv()).toThrow(/CORS_ALLOWLIST origin must be scheme:\/\/host\[:port\]/);
  });

  it('accepts an explicit production api key', () => {
    process.env.NODE_ENV = 'production';
    process.env.SITEJSON_API_KEY = STRONG_API_KEY;
    process.env.SITEJSON_OPS_API_KEY = STRONG_OPS_KEY;
    process.env.CORS_ALLOWLIST = PRODUCTION_CORS_ALLOWLIST;
    process.env.REDIS_PASSWORD = 'redis-password-value';

    const env = loadEnv();

    expect(env.NODE_ENV).toBe('production');
    expect(env.SITEJSON_API_KEY).toBe(STRONG_API_KEY);
    expect(env.SITEJSON_OPS_API_KEY).toBe(STRONG_OPS_KEY);
    expect(env.CORS_ALLOWLIST).toBe(PRODUCTION_CORS_ALLOWLIST);
    expect(env.REDIS_PASSWORD).toBe('redis-password-value');
  });

  it('accepts an optional previous production api key for rotation', () => {
    process.env.NODE_ENV = 'production';
    process.env.SITEJSON_API_KEY = STRONG_API_KEY;
    process.env.SITEJSON_API_KEY_PREVIOUS = STRONG_PREVIOUS_API_KEY;
    process.env.SITEJSON_OPS_API_KEY = STRONG_OPS_KEY;
    process.env.SITEJSON_OPS_API_KEY_PREVIOUS = STRONG_PREVIOUS_OPS_KEY;
    process.env.CORS_ALLOWLIST = PRODUCTION_CORS_ALLOWLIST;

    const env = loadEnv();

    expect(env.SITEJSON_API_KEY).toBe(STRONG_API_KEY);
    expect(env.SITEJSON_API_KEY_PREVIOUS).toBe(STRONG_PREVIOUS_API_KEY);
    expect(env.SITEJSON_OPS_API_KEY_PREVIOUS).toBe(STRONG_PREVIOUS_OPS_KEY);
  });

  it('rejects a weak previous production api key for rotation', () => {
    process.env.NODE_ENV = 'production';
    process.env.SITEJSON_API_KEY = STRONG_API_KEY;
    process.env.SITEJSON_API_KEY_PREVIOUS = 'prod-api-key-change-me';
    process.env.SITEJSON_OPS_API_KEY = STRONG_OPS_KEY;
    process.env.CORS_ALLOWLIST = PRODUCTION_CORS_ALLOWLIST;

    expect(() => loadEnv()).toThrow(/SITEJSON_API_KEY_PREVIOUS must be at least 32 characters and high entropy/);
  });

  it('parses string boolean flags without treating "false" as truthy', () => {
    process.env.INGEST_AUTO_FEED_ENABLED = 'false';
    process.env.AI_RETRY_FEED_ENABLED = '0';
    process.env.BROWSER_ENABLED = 'true';

    const env = loadEnv();

    expect(env.INGEST_AUTO_FEED_ENABLED).toBe(false);
    expect(env.AI_RETRY_FEED_ENABLED).toBe(false);
    expect(env.BROWSER_ENABLED).toBe(true);
  });

  it('keeps background feed defaults disabled unless explicitly enabled', () => {
    delete process.env.INGEST_AUTO_FEED_ENABLED;
    delete process.env.AI_RETRY_FEED_ENABLED;

    const env = loadEnv();

    expect(env.INGEST_AUTO_FEED_ENABLED).toBe(false);
    expect(env.AI_RETRY_FEED_ENABLED).toBe(false);
    expect(env.BACKGROUND_BROWSER_MAX_QUEUE_DEPTH).toBe(5_000);
    expect(env.BACKGROUND_BROWSER_DAILY_BUDGET).toBe(10_000);
    expect(env.AI_RETRY_DAILY_BUDGET).toBe(1_000);
    expect(env.REDIS_FEED_HARD_STOP_RATIO).toBe(0.85);
    expect(env.ANALYZE_RATE_LIMIT_PUBLIC_PER_MIN).toBeUndefined();
    expect(env.ANALYZE_RATE_LIMIT_OPS_PER_MIN).toBeUndefined();
    expect(env.ANALYZE_CLIENT_RATE_LIMIT_PUBLIC_PER_MIN).toBe(20);
    expect(env.ANALYZE_CLIENT_RATE_LIMIT_PRO_PER_MIN).toBe(120);
    expect(env.ANALYZE_CLIENT_RATE_LIMIT_OPS_PER_MIN).toBe(300);
    expect(env.INGEST_RATE_LIMIT_PER_MIN).toBeUndefined();
    expect(env.INGEST_RATE_LIMIT_PUBLIC_PER_MIN).toBeUndefined();
    expect(env.INGEST_RATE_LIMIT_OPS_PER_MIN).toBeUndefined();
    expect(env.INSIGHTS_RATE_LIMIT_PER_MIN).toBe(120);
    expect(env.RADAR_BULK_MIN_VALID_ROWS).toBe(1_000_000);
    expect(env.AHREFS_DR_ENABLED).toBe(false);
    expect(env.AHREFS_DR_ENDPOINT).toBe('https://api.ahrefs.com/v3/public/domain-rating-free');
    expect(env.AHREFS_DR_CACHE_TTL_HOURS).toBe(720);
    expect(env.ARCHIVE_HISTORY_ENABLED).toBe(false);
    expect(env.ARCHIVE_HISTORY_BASE_URL).toBeUndefined();
    expect(env.ARCHIVE_HISTORY_API_KEY).toBeUndefined();
    expect(env.ARCHIVE_HISTORY_COMPUTE_ON_MISS).toBe(false);
    expect(env.ARCHIVE_HISTORY_MAX_TITLES).toBe(12);
    expect(env.ARCHIVE_HISTORY_TIMEOUT_MS).toBe(4000);
    expect(env.PG_POOL_MAX_API).toBeUndefined();
    expect(env.PG_POOL_MAX_WORKER).toBeUndefined();
    expect(env.DIRECTORY_CACHE_PREWARM_TOP_SLUGS).toBe(25);
    expect(env.TRAFFIC_SIMILARWEB_FOLLOWUP_INITIAL_DELAY_MS).toBe(900_000);
    expect(env.TRAFFIC_SIMILARWEB_FOLLOWUP_POLL_INTERVAL_MS).toBe(300_000);
    expect(env.TRAFFIC_SIMILARWEB_FOLLOWUP_MAX_WAIT_MS).toBe(2_700_000);
  });

  it('parses SimilarWeb follow-up timing overrides', () => {
    process.env.TRAFFIC_SIMILARWEB_FOLLOWUP_INITIAL_DELAY_MS = '600000';
    process.env.TRAFFIC_SIMILARWEB_FOLLOWUP_POLL_INTERVAL_MS = '120000';
    process.env.TRAFFIC_SIMILARWEB_FOLLOWUP_MAX_WAIT_MS = '1800000';

    const env = loadEnv();

    expect(env.TRAFFIC_SIMILARWEB_FOLLOWUP_INITIAL_DELAY_MS).toBe(600_000);
    expect(env.TRAFFIC_SIMILARWEB_FOLLOWUP_POLL_INTERVAL_MS).toBe(120_000);
    expect(env.TRAFFIC_SIMILARWEB_FOLLOWUP_MAX_WAIT_MS).toBe(1_800_000);
  });

  it('allows disabling the public insights route limiter explicitly', () => {
    process.env.INSIGHTS_RATE_LIMIT_PER_MIN = '0';

    const env = loadEnv();

    expect(env.INSIGHTS_RATE_LIMIT_PER_MIN).toBe(0);
  });

  it('parses the Ahrefs DR provider flag and endpoint override', () => {
    process.env.AHREFS_DR_ENABLED = 'true';
    process.env.AHREFS_DR_ENDPOINT = 'https://api.example.test/domain-rating';
    process.env.AHREFS_DR_CACHE_TTL_HOURS = '168';

    const env = loadEnv();

    expect(env.AHREFS_DR_ENABLED).toBe(true);
    expect(env.AHREFS_DR_ENDPOINT).toBe('https://api.example.test/domain-rating');
    expect(env.AHREFS_DR_CACHE_TTL_HOURS).toBe(168);
  });

  it('parses the ArchiveRisk history provider settings', () => {
    process.env.ARCHIVE_HISTORY_ENABLED = 'true';
    process.env.ARCHIVE_HISTORY_BASE_URL = 'http://archiverisk-web:3000';
    process.env.ARCHIVE_HISTORY_API_KEY = '  archive-history-key  ';
    process.env.ARCHIVE_HISTORY_COMPUTE_ON_MISS = 'true';
    process.env.ARCHIVE_HISTORY_MAX_TITLES = '20';
    process.env.ARCHIVE_HISTORY_TIMEOUT_MS = '2500';

    const env = loadEnv();

    expect(env.ARCHIVE_HISTORY_ENABLED).toBe(true);
    expect(env.ARCHIVE_HISTORY_BASE_URL).toBe('http://archiverisk-web:3000');
    expect(env.ARCHIVE_HISTORY_API_KEY).toBe('archive-history-key');
    expect(env.ARCHIVE_HISTORY_COMPUTE_ON_MISS).toBe(true);
    expect(env.ARCHIVE_HISTORY_MAX_TITLES).toBe(20);
    expect(env.ARCHIVE_HISTORY_TIMEOUT_MS).toBe(2500);
  });

  it('parses optional tier-specific analyze and ingest rate limits', () => {
    process.env.ANALYZE_RATE_LIMIT_PUBLIC_PER_MIN = '45';
    process.env.ANALYZE_RATE_LIMIT_OPS_PER_MIN = '240';
    process.env.ANALYZE_CLIENT_RATE_LIMIT_PUBLIC_PER_MIN = '15';
    process.env.ANALYZE_CLIENT_RATE_LIMIT_OPS_PER_MIN = '180';
    process.env.INGEST_RATE_LIMIT_PER_MIN = '30';
    process.env.INGEST_RATE_LIMIT_OPS_PER_MIN = '90';

    const env = loadEnv();

    expect(env.ANALYZE_RATE_LIMIT_PUBLIC_PER_MIN).toBe(45);
    expect(env.ANALYZE_RATE_LIMIT_OPS_PER_MIN).toBe(240);
    expect(env.ANALYZE_CLIENT_RATE_LIMIT_PUBLIC_PER_MIN).toBe(15);
    expect(env.ANALYZE_CLIENT_RATE_LIMIT_OPS_PER_MIN).toBe(180);
    expect(env.INGEST_RATE_LIMIT_PER_MIN).toBe(30);
    expect(env.INGEST_RATE_LIMIT_OPS_PER_MIN).toBe(90);
  });

  it('parses optional role-specific postgres pool limits', () => {
    process.env.PG_POOL_MAX_API = '20';
    process.env.PG_POOL_MAX_WORKER = '50';
    process.env.BROWSER_NETWORKIDLE_TIMEOUT_MS = '0';
    process.env.PROVIDER_TIMEOUT_MS_FAST = '3500';

    const env = loadEnv();

    expect(env.PG_POOL_MAX_API).toBe(20);
    expect(env.PG_POOL_MAX_WORKER).toBe(50);
    expect(env.BROWSER_NETWORKIDLE_TIMEOUT_MS).toBe(0);
    expect(env.PROVIDER_TIMEOUT_MS_FAST).toBe(3500);
  });
});
