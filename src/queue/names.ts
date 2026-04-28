export const QUEUE_NAMES = {
  ingest: 'ingest',
  browserRealtime: 'browser_realtime',
  browser: 'browser',
  async: 'async',
  radar: 'radar',
  traffic: 'traffic',
  whois: 'whois',
} as const;

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES];

export const DEFAULT_QUEUE_NAME: QueueName = QUEUE_NAMES.browserRealtime;

export const ALL_QUEUE_NAMES: QueueName[] = [
  QUEUE_NAMES.ingest,
  QUEUE_NAMES.browserRealtime,
  QUEUE_NAMES.browser,
  QUEUE_NAMES.async,
  QUEUE_NAMES.radar,
  QUEUE_NAMES.traffic,
  QUEUE_NAMES.whois,
];
