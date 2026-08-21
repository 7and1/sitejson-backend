import { z } from 'zod';
import { SIMILARWEB_SEED_MAX_BATCH_SIZE } from '../lib/similarweb-seed.js';

const parseViewport = (value: string): { width: number; height: number } => {
  const match = value.match(/^(\d+)x(\d+)$/i);
  if (!match) {
    return { width: 1280, height: 800 };
  }

  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1280, height: 800 };
  }

  return { width, height };
};

const blankToUndefined = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const booleanFromEnv = (defaultValue: boolean) => z.preprocess((value) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return value;
}, z.boolean().default(defaultValue));

const optionalNonNegativeInt = () => z.preprocess(blankToUndefined, z.coerce.number().int().min(0).optional());
const optionalPositiveInt = () => z.preprocess(blankToUndefined, z.coerce.number().int().positive().max(200).optional());

const INVALID_PRODUCTION_API_KEYS = new Set([
  'dev-api-key',
  'prod-api-key-change-me',
  'your_api_key_here',
]);

const MIN_PRODUCTION_API_KEY_LENGTH = 32;
const MIN_PRODUCTION_API_KEY_ENTROPY = 3.5;
const WEAK_API_KEY_PATTERNS = [
  'changeme',
  'placeholder',
  'yourapikey',
  'devapikey',
  'testapikey',
  'prodapikey',
  'sitejsonprodkey',
];

const calculateEntropyBitsPerChar = (value: string): number => {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }

  return entropy;
};

const isWeakProductionApiKey = (value: string): boolean => {
  const trimmed = value.trim();
  if (trimmed.length < MIN_PRODUCTION_API_KEY_LENGTH) {
    return true;
  }

  if (INVALID_PRODUCTION_API_KEYS.has(trimmed)) {
    return true;
  }

  const compact = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (WEAK_API_KEY_PATTERNS.some((pattern) => compact.includes(pattern))) {
    return true;
  }

  return calculateEntropyBitsPerChar(trimmed) < MIN_PRODUCTION_API_KEY_ENTROPY;
};

const assertStrongProductionApiKey = (name: string, value: string | undefined): void => {
  if (!value || isWeakProductionApiKey(value)) {
    throw new Error(`Invalid environment configuration: ${name} must be at least ${MIN_PRODUCTION_API_KEY_LENGTH} characters and high entropy in production`);
  }
};

const parseCorsAllowlist = (raw: string): string[] => (
  raw.split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);

const assertProductionCorsAllowlist = (value: string): void => {
  const origins = parseCorsAllowlist(value);
  if (origins.length === 0 || origins.includes('*')) {
    throw new Error('Invalid environment configuration: CORS_ALLOWLIST must be an explicit origin allowlist in production');
  }

  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Invalid environment configuration: CORS_ALLOWLIST contains invalid origin ${origin}`);
    }

    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new Error(`Invalid environment configuration: CORS_ALLOWLIST origin must be scheme://host[:port]: ${origin}`);
    }
  }
};

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  STORAGE_DRIVER: z.enum(['memory', 'postgres']).default('memory'),
  QUEUE_DRIVER: z.enum(['memory', 'bullmq']).default('memory'),
  PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SITEJSON_API_KEY: z.preprocess(blankToUndefined, z.string().default('dev-api-key')),
  SITEJSON_API_KEY_PREVIOUS: z.preprocess(blankToUndefined, z.string().optional()),
  SITEJSON_OPS_API_KEY: z.preprocess(blankToUndefined, z.string().default('dev-ops-api-key')),
  SITEJSON_OPS_API_KEY_PREVIOUS: z.preprocess(blankToUndefined, z.string().optional()),
  // Pro tier: privileged analyze (priority/force) without /ops/* control access.
  // Optional — absent means no pro tier is enabled (backward compatible).
  SITEJSON_PRO_API_KEY: z.preprocess(blankToUndefined, z.string().optional()),
  SITEJSON_PRO_API_KEY_PREVIOUS: z.preprocess(blankToUndefined, z.string().optional()),
  SITEJSON_SERVICE_NAME: z.preprocess(blankToUndefined, z.string().default('sitejson-backend')),
  CORS_ALLOWLIST: z.preprocess(blankToUndefined, z.string().default('*')),
  SITE_REPORT_TTL_SEC: z.coerce.number().int().positive().default(604800),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  PROVIDER_TIMEOUT_MS_FAST: z.coerce.number().int().positive().default(5000),
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  PROVIDER_RETRY_ATTEMPTS: z.coerce.number().int().min(0).default(2),
  PROVIDER_RETRY_BASE_MS: z.coerce.number().int().positive().default(250),
  ANALYZE_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
  ANALYZE_RATE_LIMIT_PUBLIC_PER_MIN: optionalNonNegativeInt(),
  ANALYZE_RATE_LIMIT_PRO_PER_MIN: optionalNonNegativeInt(),
  ANALYZE_RATE_LIMIT_OPS_PER_MIN: optionalNonNegativeInt(),
  ANALYZE_CLIENT_RATE_LIMIT_PUBLIC_PER_MIN: z.coerce.number().int().min(0).default(20),
  ANALYZE_CLIENT_RATE_LIMIT_PRO_PER_MIN: z.coerce.number().int().min(0).default(120),
  ANALYZE_CLIENT_RATE_LIMIT_OPS_PER_MIN: z.coerce.number().int().min(0).default(300),
  INGEST_RATE_LIMIT_PER_MIN: optionalNonNegativeInt(),
  INGEST_RATE_LIMIT_PUBLIC_PER_MIN: optionalNonNegativeInt(),
  INGEST_RATE_LIMIT_PRO_PER_MIN: optionalNonNegativeInt(),
  INGEST_RATE_LIMIT_OPS_PER_MIN: optionalNonNegativeInt(),
  INSIGHTS_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(0).default(120),
  INGEST_MAX_DOMAINS: z.coerce.number().int().min(1).max(5000).default(100),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(25000),
  AI_ENABLE_AUTO_TRIGGER: booleanFromEnv(true),
  AI_AUTO_TRIGGER_RANK_LIMIT: z.coerce.number().int().positive().default(1_000_000),
  AI_VISION_RANK_LIMIT: z.coerce.number().int().min(0).default(100_000),
  USER_AGENT: z.string().default('SiteJSONBot/1.0 (+https://sitejson.com)'),
  MOONSHOT_API_KEY: z.string().optional().transform(v => v?.trim() || undefined),
  AI_BASE_URL: z.string().default('https://api.kimi.com/coding'),
  AI_MODEL: z.string().default('kimi'),
  GEMINI_API_KEY: z.string().optional().transform(v => v?.trim() || undefined),
  GEMINI_MODEL: z.string().default('gemini-1.5-flash'),
  BIGMODEL_API_KEY: z.string().optional().transform(v => v?.trim() || undefined),
  BIGMODEL_BASE_URL: z.string().default('https://open.bigmodel.cn/api/anthropic'),
  BIGMODEL_MODEL: z.string().default('glm-5'),
  CODEX_API_KEY: z.string().optional().transform(v => v?.trim() || undefined),
  CODEX_BASE_URL: z.string().default('https://right.codes/codex/v1'),
  CODEX_MODEL: z.string().default('gpt-5.2-high'),
  CODEX_WIRE_API: z.enum(['chat-completions', 'responses']).optional(),
  AI_VISION_ENABLED: z.string().default('true').transform(v => v === 'true' || v === '1'),
  AI_PROMPT_VERSION: z.coerce.number().int().positive().default(1),
  AI_SKIP_DEFAULT: booleanFromEnv(false),
  TAXONOMY_CACHE_TTL_SEC: z.coerce.number().int().positive().default(604800),
  DATABASE_URL: z.string().optional(),
  PG_POOL_MAX: z.coerce.number().int().positive().max(200).default(10),
  PG_POOL_MAX_API: optionalPositiveInt(),
  PG_POOL_MAX_WORKER: optionalPositiveInt(),
  PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  DIRECTORY_CACHE_PREWARM_ENABLED: booleanFromEnv(true),
  DIRECTORY_CACHE_PREWARM_TOP_SLUGS: z.coerce.number().int().nonnegative().default(25),
  REDIS_URL: z.string().optional(),
  REDIS_PASSWORD: z.preprocess(blankToUndefined, z.string().optional()),
  QUEUE_NAME: z.string().default('sitejson-analysis'),
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(4),
  QUEUE_CONCURRENCY_BROWSER_REALTIME: z.coerce.number().int().positive().default(4),
  QUEUE_CONCURRENCY_BROWSER: z.coerce.number().int().positive().default(10),
  QUEUE_CONCURRENCY_ASYNC: z.coerce.number().int().positive().default(50),
  QUEUE_CONCURRENCY_TRAFFIC: z.coerce.number().int().positive().default(50),
  QUEUE_CONCURRENCY_WHOIS: z.coerce.number().int().positive().default(20),
  QUEUE_CONCURRENCY_RADAR: z.coerce.number().int().positive().default(4),
  QUEUE_CONCURRENCY_INGEST: z.coerce.number().int().positive().default(4),
  RADAR_BULK_ENABLED: booleanFromEnv(false),
  RADAR_DATASET_TYPE: z.string().default('ranking_bucket'),
  PROXY_LIST: z.string().optional(),
  PROXY_LIST_FALLBACK: z.string().optional(),
  PROXY_LIST_FILE: z.preprocess(blankToUndefined, z.string().optional()),
  PROXY_LIST_FALLBACK_FILE: z.preprocess(blankToUndefined, z.string().optional()),
  PROXY_GRID_BASE_URL: z.preprocess(blankToUndefined, z.string().default('https://google.savedimage.com')),
  PROXY_GRID_SECRET: z.string().optional(),
  SOAX_API_URL: z.preprocess(
    blankToUndefined,
    z.string().default('https://scraping.soax.com/v1/webdata/fetch-content'),
  ),
  SOAX_API_SECRET: z.string().optional(),
  SOAX_PROXY_COUNTRY: z.preprocess(blankToUndefined, z.string().default('us')),
  SOAX_PROXY_TYPE: z.coerce.number().int().positive().default(1),
  FLARESOLVERR_BASE_URL: z.preprocess(blankToUndefined, z.string().optional()),
  FLARESOLVERR_TIMEOUT_MS: z.coerce.number().int().positive().default(35000),
  FLARESOLVERR_MAX_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  FLARESOLVERR_SESSION: z.preprocess(blankToUndefined, z.string().optional()),
  BROWSER_ENABLED: booleanFromEnv(true),
  BROWSER_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  BROWSER_TIMEOUT_MS_HIGH_VALUE: z.coerce.number().int().positive().default(30000),
  BROWSER_NETWORKIDLE_TIMEOUT_MS: z.coerce.number().int().min(0).default(1500),
  BROWSER_VIEWPORT: z.string().default('1280x800'),
  SCREENSHOT_STORAGE: z.enum(['local', 'r2']).default('local'),
  SCREENSHOT_LOCAL_DIR: z.string().default('tmp/screenshots'),
  SCREENSHOT_PUBLIC_BASE_URL: z.string().default(''),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  RADAR_TTL_SEC: z.coerce.number().int().positive().default(86400),
  RADAR_BULK_BATCH_SIZE: z.coerce.number().int().min(1000).max(50000).default(10000),
  RADAR_BULK_MIN_VALID_ROWS: z.coerce.number().int().min(0).default(1_000_000),
  TRAFFIC_REFRESH_START_DAY: z.coerce.number().int().min(1).max(28).default(10),
  TRAFFIC_REFRESH_SPREAD_DAYS: z.coerce.number().int().min(1).max(31).default(30),
  WHOIS_REFRESH_SPREAD_DAYS: z.coerce.number().int().min(1).max(28).default(7),
  TRAFFIC_SUCCESS_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 30),
  TRAFFIC_NO_DATA_COOLDOWN_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 7),
  TRAFFIC_NO_DATA_MAX_COOLDOWN_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 30),
  TRAFFIC_MONTHLY_SEED_ENABLED: booleanFromEnv(false),
  TRAFFIC_FASTLANE_ENABLED: booleanFromEnv(false),
  TRAFFIC_FASTLANE_CRON: z.string().default('15 * * * *'),
  TRAFFIC_FASTLANE_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(10),
  TRAFFIC_FASTLANE_MAX_SNAPSHOT_AGE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  TRAFFIC_SIMILARWEB_SEED_ENABLED: booleanFromEnv(true),
  TRAFFIC_SIMILARWEB_SEED_CRON: z.string().default('0 * * * *'),
  TRAFFIC_SIMILARWEB_SEED_BATCH_SIZE: z.coerce.number().int().min(1).max(SIMILARWEB_SEED_MAX_BATCH_SIZE).default(10),
  TRAFFIC_SIMILARWEB_FOLLOWUP_INITIAL_DELAY_MS: z.coerce.number().int().positive().default(900000),
  TRAFFIC_SIMILARWEB_FOLLOWUP_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(300000),
  TRAFFIC_SIMILARWEB_FOLLOWUP_MAX_WAIT_MS: z.coerce.number().int().positive().default(2700000),
  INGEST_AUTO_FEED_ENABLED: booleanFromEnv(false),
  INGEST_AUTO_FEED_CRON: z.string().default('*/5 * * * *'),
  INGEST_AUTO_FEED_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
  INGEST_AUTO_FEED_MAX_RANK: z.coerce.number().int().min(1).max(1_000_000).default(1_000_000),
  CRAWL_JOB_REAPER_STALE_HOURS: z.coerce.number().int().positive().default(2),
  CRAWL_JOB_REAPER_LIMIT: z.coerce.number().int().min(1).max(50000).default(5000),
  BACKGROUND_BROWSER_MAX_QUEUE_DEPTH: z.coerce.number().int().min(0).default(5_000),
  BACKGROUND_BROWSER_DAILY_BUDGET: z.coerce.number().int().min(0).default(10_000),
  AI_RETRY_FEED_ENABLED: booleanFromEnv(false),
  AI_RETRY_FEED_CRON: z.string().default('*/15 * * * *'),
  AI_RETRY_FEED_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(300),
  AI_RETRY_FEED_MAX_RANK: z.coerce.number().int().min(1).max(1_000_000).default(1_000_000),
  AI_RETRY_DAILY_BUDGET: z.coerce.number().int().min(0).default(1_000),
  REDIS_FEED_HARD_STOP_RATIO: z.coerce.number().min(0).max(1).default(0.85),
  WHOIS_SUCCESS_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 30),
  WHOIS_NO_DATA_COOLDOWN_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 7),
  WHOIS_NO_DATA_MAX_COOLDOWN_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 30),
  TRAFFIC_FALLBACK_CHAIN_ENABLED: booleanFromEnv(false),
  TRAFFIC_SIMILARWEB_ENABLED: booleanFromEnv(true),
  TRAFFIC_SIMILARWEB_BASE_URL: z.preprocess(blankToUndefined, z.string().optional()),
  TRAFFIC_SIMILARWEB_API_KEY: z.string().optional().transform(v => v?.trim() || undefined),
  TRAFFIC_SIMILARWEB_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  TRAFFIC_SIMILARWEB_TIMEOUT_MS: z.coerce.number().int().positive().default(12000),
  ARCHIVE_HISTORY_ENABLED: booleanFromEnv(false),
  ARCHIVE_HISTORY_BASE_URL: z.preprocess(blankToUndefined, z.string().optional()),
  ARCHIVE_HISTORY_API_KEY: z.string().optional().transform(v => v?.trim() || undefined),
  ARCHIVE_HISTORY_COMPUTE_ON_MISS: booleanFromEnv(false),
  ARCHIVE_HISTORY_MAX_TITLES: z.coerce.number().int().min(1).max(50).default(12),
  ARCHIVE_HISTORY_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  TRAFFIC_ROTATION_MAX_PRIMARY_PROXIES: z.coerce.number().int().min(1).max(12).default(4),
  AHREFS_DR_ENABLED: booleanFromEnv(false),
  AHREFS_DR_ENDPOINT: z.preprocess(
    blankToUndefined,
    z.string().url().default('https://api.ahrefs.com/v3/public/domain-rating-free'),
  ),
  AHREFS_DR_CACHE_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 365).default(720),
  WORKER_QUEUES: z.string().optional(),
  WORKER_HEARTBEAT_FILE: z.preprocess(blankToUndefined, z.string().optional()),
  BROWSER_POOL_SIZE: z.coerce.number().int().min(0).default(0),
});

export type Env = z.infer<typeof envSchema> & {
  BROWSER_VIEWPORT_PARSED: { width: number; height: number };
};

export const loadEnv = (): Env => {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${message}`);
  }

  if (parsed.data.NODE_ENV === 'production') {
    assertStrongProductionApiKey('SITEJSON_API_KEY', parsed.data.SITEJSON_API_KEY);
    assertStrongProductionApiKey('SITEJSON_OPS_API_KEY', parsed.data.SITEJSON_OPS_API_KEY);
    if (parsed.data.SITEJSON_API_KEY_PREVIOUS) {
      assertStrongProductionApiKey('SITEJSON_API_KEY_PREVIOUS', parsed.data.SITEJSON_API_KEY_PREVIOUS);
    }
    if (parsed.data.SITEJSON_OPS_API_KEY_PREVIOUS) {
      assertStrongProductionApiKey('SITEJSON_OPS_API_KEY_PREVIOUS', parsed.data.SITEJSON_OPS_API_KEY_PREVIOUS);
    }
    if (parsed.data.SITEJSON_PRO_API_KEY) {
      assertStrongProductionApiKey('SITEJSON_PRO_API_KEY', parsed.data.SITEJSON_PRO_API_KEY);
    }
    if (parsed.data.SITEJSON_PRO_API_KEY_PREVIOUS) {
      assertStrongProductionApiKey('SITEJSON_PRO_API_KEY_PREVIOUS', parsed.data.SITEJSON_PRO_API_KEY_PREVIOUS);
    }
    assertProductionCorsAllowlist(parsed.data.CORS_ALLOWLIST);
  }

  return {
    ...parsed.data,
    BROWSER_VIEWPORT_PARSED: parseViewport(parsed.data.BROWSER_VIEWPORT),
  };
};
