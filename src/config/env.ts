import { z } from 'zod';

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

const INVALID_PRODUCTION_API_KEYS = new Set([
  'dev-api-key',
  'prod-api-key-change-me',
  'your_api_key_here',
]);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  STORAGE_DRIVER: z.enum(['memory', 'postgres']).default('memory'),
  QUEUE_DRIVER: z.enum(['memory', 'bullmq']).default('memory'),
  PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SITEJSON_API_KEY: z.preprocess(blankToUndefined, z.string().default('dev-api-key')),
  SITEJSON_API_KEY_PREVIOUS: z.preprocess(blankToUndefined, z.string().optional()),
  SITE_REPORT_TTL_SEC: z.coerce.number().int().positive().default(604800),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  PROVIDER_RETRY_ATTEMPTS: z.coerce.number().int().min(0).default(2),
  PROVIDER_RETRY_BASE_MS: z.coerce.number().int().positive().default(250),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(25000),
  AI_ENABLE_AUTO_TRIGGER: z.coerce.boolean().default(true),
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
  AI_SKIP_DEFAULT: z.coerce.boolean().default(false),
  TAXONOMY_CACHE_TTL_SEC: z.coerce.number().int().positive().default(604800),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  QUEUE_NAME: z.string().default('sitejson-analysis'),
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(4),
  QUEUE_CONCURRENCY_BROWSER_REALTIME: z.coerce.number().int().positive().default(4),
  QUEUE_CONCURRENCY_BROWSER: z.coerce.number().int().positive().default(10),
  QUEUE_CONCURRENCY_ASYNC: z.coerce.number().int().positive().default(50),
  QUEUE_CONCURRENCY_TRAFFIC: z.coerce.number().int().positive().default(50),
  QUEUE_CONCURRENCY_WHOIS: z.coerce.number().int().positive().default(20),
  QUEUE_CONCURRENCY_RADAR: z.coerce.number().int().positive().default(4),
  QUEUE_CONCURRENCY_INGEST: z.coerce.number().int().positive().default(4),
  RADAR_BULK_ENABLED: z.coerce.boolean().default(false),
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
  BROWSER_ENABLED: z.coerce.boolean().default(true),
  BROWSER_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  BROWSER_TIMEOUT_MS_HIGH_VALUE: z.coerce.number().int().positive().default(30000),
  BROWSER_VIEWPORT: z.string().default('1280x800'),
  SCREENSHOT_STORAGE: z.enum(['local', 'r2']).default('local'),
  SCREENSHOT_LOCAL_DIR: z.string().default('tmp/screenshots'),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  RADAR_TTL_SEC: z.coerce.number().int().positive().default(86400),
  RADAR_BULK_BATCH_SIZE: z.coerce.number().int().min(1000).max(50000).default(10000),
  TRAFFIC_REFRESH_START_DAY: z.coerce.number().int().min(1).max(28).default(10),
  TRAFFIC_REFRESH_SPREAD_DAYS: z.coerce.number().int().min(1).max(31).default(30),
  WHOIS_REFRESH_SPREAD_DAYS: z.coerce.number().int().min(1).max(28).default(7),
  TRAFFIC_SUCCESS_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 30),
  TRAFFIC_NO_DATA_COOLDOWN_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 7),
  TRAFFIC_NO_DATA_MAX_COOLDOWN_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 30),
  TRAFFIC_FASTLANE_ENABLED: z.coerce.boolean().default(false),
  TRAFFIC_FASTLANE_CRON: z.string().default('*/10 * * * *'),
  TRAFFIC_FASTLANE_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(800),
  TRAFFIC_FASTLANE_MAX_SNAPSHOT_AGE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  INGEST_AUTO_FEED_ENABLED: z.coerce.boolean().default(true),
  INGEST_AUTO_FEED_CRON: z.string().default('*/5 * * * *'),
  INGEST_AUTO_FEED_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
  INGEST_AUTO_FEED_MAX_RANK: z.coerce.number().int().min(1).max(1_000_000).default(1_000_000),
  AI_RETRY_FEED_ENABLED: z.coerce.boolean().default(true),
  AI_RETRY_FEED_CRON: z.string().default('*/15 * * * *'),
  AI_RETRY_FEED_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(300),
  AI_RETRY_FEED_MAX_RANK: z.coerce.number().int().min(1).max(1_000_000).default(1_000_000),
  WHOIS_SUCCESS_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 30),
  WHOIS_NO_DATA_COOLDOWN_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 7),
  WHOIS_NO_DATA_MAX_COOLDOWN_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 30),
  TRAFFIC_FALLBACK_CHAIN_ENABLED: z.coerce.boolean().default(false),
  TRAFFIC_SIMILARWEB_ENABLED: z.coerce.boolean().default(true),
  TRAFFIC_SIMILARWEB_BASE_URL: z.preprocess(blankToUndefined, z.string().optional()),
  TRAFFIC_SIMILARWEB_API_KEY: z.string().optional().transform(v => v?.trim() || undefined),
  TRAFFIC_SIMILARWEB_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  TRAFFIC_SIMILARWEB_TIMEOUT_MS: z.coerce.number().int().positive().default(12000),
  TRAFFIC_ROTATION_MAX_PRIMARY_PROXIES: z.coerce.number().int().min(1).max(12).default(4),
  WORKER_QUEUES: z.string().optional(),
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

  if (parsed.data.NODE_ENV === 'production' && INVALID_PRODUCTION_API_KEYS.has(parsed.data.SITEJSON_API_KEY)) {
    throw new Error('Invalid environment configuration: SITEJSON_API_KEY must be explicitly configured for production');
  }

  return {
    ...parsed.data,
    BROWSER_VIEWPORT_PARSED: parseViewport(parsed.data.BROWSER_VIEWPORT),
  };
};
