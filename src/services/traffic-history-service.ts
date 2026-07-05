import { fetchWithRetry } from '../providers/http.js';

export type TrafficHistorySnapshot = {
  snapshotDate: string;
  monthlyVisits: number | null;
  monthlyVisitsChange: number | null;
  globalRank: number | null;
  countryRank: number | null;
  categoryRank: number | null;
  bounceRate: number | null;
  pagesPerVisit: number | null;
  avgVisitDuration: number | null;
  dataSource: string | null;
  collectedAt: string | null;
};

export type SiteTrafficHistory = {
  domain: string;
  totalSnapshots: number;
  pagination: {
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  snapshots: TrafficHistorySnapshot[];
};

type SimilarwebHistoryResponse = {
  ok?: boolean;
  data?: {
    domain?: string;
    total_snapshots?: number;
    snapshots?: Array<{
      snapshot_date?: string;
      monthly_visits?: number | null;
      monthly_visits_change?: number | null;
      global_rank?: number | null;
      country_rank?: number | null;
      category_rank?: number | null;
      bounce_rate?: number | null;
      pages_per_visit?: number | null;
      avg_visit_duration?: number | null;
      data_source?: string | null;
      created_at?: string | null;
    }>;
    pagination?: {
      limit?: number;
      offset?: number;
      has_more?: boolean;
    };
  };
};

type TrafficHistoryOptions = {
  limit?: number;
  offset?: number;
  from?: string;
  to?: string;
};

const normalizeNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

export class TrafficHistoryService {
  constructor(
    private readonly config: {
      enabled?: boolean;
      baseUrl?: string;
      apiKey?: string;
      timeoutMs?: number;
      retryAttempts?: number;
      retryBaseMs?: number;
    },
  ) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.enabled !== false
      && this.config.baseUrl?.trim()
      && this.config.apiKey?.trim(),
    );
  }

  private buildUrl(domain: string, options: TrafficHistoryOptions = {}): string {
    const baseUrl = this.config.baseUrl?.trim().replace(/\/+$/u, '') ?? '';
    const params = new URLSearchParams();
    params.set('limit', String(Math.max(1, Math.min(24, Math.trunc(options.limit ?? 12)))));
    params.set('offset', String(Math.max(0, Math.trunc(options.offset ?? 0))));
    if (options.from) params.set('from', options.from);
    if (options.to) params.set('to', options.to);
    return `${baseUrl}/api/v1/domain/${encodeURIComponent(domain)}/history?${params.toString()}`;
  }

  async getHistory(domain: string, options: TrafficHistoryOptions = {}): Promise<SiteTrafficHistory | null> {
    if (!this.isConfigured()) {
      return null;
    }

    let response: Awaited<ReturnType<typeof fetchWithRetry>>;
    try {
      response = await fetchWithRetry(this.buildUrl(domain, options), {
        timeoutMs: Math.max(1000, Math.trunc(this.config.timeoutMs ?? 12000)),
        retryAttempts: this.config.retryAttempts ?? 2,
        retryBaseMs: this.config.retryBaseMs ?? 500,
        requestInit: {
          headers: {
            accept: 'application/json',
            'x-api-key': this.config.apiKey!.trim(),
          },
        },
      });
    } catch (error) {
      // fetchWithRetry throws Error('HTTP_<status>') on non-2xx responses. A 404
      // from the SimilarWeb history API means "no history collected for this domain",
      // which the route surfaces as a clean 404 — not a 500.
      if (error instanceof Error && error.message === 'HTTP_404') {
        return null;
      }
      throw error;
    }

    if (response.status === 404) {
      return null;
    }

    const payload = await response.json() as SimilarwebHistoryResponse;
    if (!payload.ok || !payload.data) {
      return null;
    }

    return {
      domain: payload.data.domain ?? domain,
      totalSnapshots: Math.max(0, Math.trunc(payload.data.total_snapshots ?? 0)),
      pagination: {
        limit: Math.max(1, Math.trunc(payload.data.pagination?.limit ?? options.limit ?? 12)),
        offset: Math.max(0, Math.trunc(payload.data.pagination?.offset ?? options.offset ?? 0)),
        hasMore: payload.data.pagination?.has_more === true,
      },
      snapshots: (payload.data.snapshots ?? []).map((snapshot) => ({
        snapshotDate: snapshot.snapshot_date ?? '',
        monthlyVisits: normalizeNumber(snapshot.monthly_visits),
        monthlyVisitsChange: normalizeNumber(snapshot.monthly_visits_change),
        globalRank: normalizeNumber(snapshot.global_rank),
        countryRank: normalizeNumber(snapshot.country_rank),
        categoryRank: normalizeNumber(snapshot.category_rank),
        bounceRate: normalizeNumber(snapshot.bounce_rate),
        pagesPerVisit: normalizeNumber(snapshot.pages_per_visit),
        avgVisitDuration: normalizeNumber(snapshot.avg_visit_duration),
        dataSource: typeof snapshot.data_source === 'string' ? snapshot.data_source : null,
        collectedAt: typeof snapshot.created_at === 'string' ? snapshot.created_at : null,
      })),
    };
  }
}
