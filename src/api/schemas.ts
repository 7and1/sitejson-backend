import { z } from 'zod';

export const analyzeRequestSchema = z.object({
  domain: z.string().min(3),
  force_refresh: z.boolean().optional(),
  force_ai: z.boolean().optional(),
  skip_ai: z.boolean().optional(),
  priority: z.enum(['normal', 'high']).optional(),
});

export const directoryParamsSchema = z.object({
  type: z.enum(['category', 'technology', 'topic']),
  slug: z.string().min(1),
});

export const alternativesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

export const opsDashboardQuerySchema = z.object({
  window: z.enum(['1h']).optional(),
  recent_limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const ingestDomainsSchema = z.object({
  domains: z.array(z.string().min(3)).min(1).max(5000),
  priority: z.enum(['normal', 'high']).optional(),
  force_refresh: z.boolean().optional(),
  force_ai: z.boolean().optional(),
  skip_ai: z.boolean().optional(),
});

export const retryDlqSchema = z.object({
  queue: z.enum(['ingest', 'browser_realtime', 'browser', 'async', 'radar', 'traffic', 'whois']),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
