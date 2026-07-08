import type { CrawlContext } from '../core/types.js';
import { providerFailure, providerSuccess } from './base.js';
import type { Provider } from './base.js';
import { fetchWithRetry } from './http.js';
import type { HistoryData, ProviderRuntimeOptions } from './types.js';

type ArchiveRiskScoreBand = 'clean' | 'watch' | 'review' | 'reject' | 'no_data';
type ArchiveRiskVerdict = 'reject' | 'review' | 'watch' | 'likely_clean' | 'no_data';
type ArchiveRiskStatus = 'ready' | 'pending' | 'failed';

type ArchiveRiskEnvelope = {
  ok?: boolean;
  data?: {
    history?: ArchiveRiskHistory | null;
    state?: 'miss';
  };
  error?: {
    code?: unknown;
    message?: unknown;
  };
};

type ArchiveRiskHistory = {
  status: ArchiveRiskStatus;
  score: number | null;
  scoreBand: ArchiveRiskScoreBand;
  verdict: ArchiveRiskVerdict;
  label: string;
  language: string;
  sensitiveWords?: string[];
  riskFlags?: string[];
  metrics: {
    firstCaptureYear: number | null;
    lastCaptureYear: number | null;
    historyAgeMonths: number;
    longestStreakYears: number;
    distinctBuildingYears: number;
    recentYearsBuilt: number;
    yearHistogram: Array<{
      year: number;
      count: number;
    }>;
  };
  titles: Array<{
    year: number;
    timestamp: string;
    title: string;
    archiveUrl: string;
  }>;
  capturesCount: number;
  computedAt: string;
  cacheHit?: boolean;
};

export interface ArchiveHistoryConfig {
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string;
  computeOnMiss: boolean;
  maxTitles: number;
  timeoutMs: number;
}

const normalizeHistoryErrorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = message.match(/HTTP_(\d{3})/u);
  const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : null;

  if (status === 400) return 'ARCHIVE_HISTORY_BAD_REQUEST';
  if (status === 401 || status === 403) return 'ARCHIVE_HISTORY_ACCESS_RESTRICTED';
  if (status === 429) return 'ARCHIVE_HISTORY_RATE_LIMITED';
  if (status && status >= 500) return 'ARCHIVE_HISTORY_UPSTREAM_ERROR';
  if (/timeout|abort/i.test(message)) return 'ARCHIVE_HISTORY_TIMEOUT';
  return 'ARCHIVE_HISTORY_FETCH_FAILED';
};

const missPayload = (): HistoryData => ({
  status: 'miss',
  source: 'archiverisk',
  cacheHit: false,
  archiveScore: null,
  archiveScoreBand: 'no_data',
  archiveVerdict: 'no_data',
  label: 'No cached history',
  language: 'Unknown',
  sensitiveWords: [],
  riskFlags: [],
  firstCaptureYear: null,
  lastCaptureYear: null,
  historyAgeMonths: 0,
  longestStreakYears: 0,
  distinctBuildingYears: 0,
  recentYearsBuilt: 0,
  capturesCount: 0,
  yearHistogram: [],
  titles: [],
  computedAt: null,
});

const mapArchiveRiskToHistoryData = (
  payload: ArchiveRiskHistory,
  options: { maxTitles: number; cacheHit: boolean },
): HistoryData => ({
  status: payload.status,
  source: 'archiverisk',
  cacheHit: payload.cacheHit === true || options.cacheHit,
  archiveScore: payload.score,
  archiveScoreBand: payload.scoreBand,
  archiveVerdict: payload.verdict,
  label: payload.label,
  language: payload.language,
  sensitiveWords: payload.sensitiveWords ?? [],
  riskFlags: payload.riskFlags ?? [],
  firstCaptureYear: payload.metrics.firstCaptureYear,
  lastCaptureYear: payload.metrics.lastCaptureYear,
  historyAgeMonths: payload.metrics.historyAgeMonths,
  longestStreakYears: payload.metrics.longestStreakYears,
  distinctBuildingYears: payload.metrics.distinctBuildingYears,
  recentYearsBuilt: payload.metrics.recentYearsBuilt,
  capturesCount: payload.capturesCount,
  yearHistogram: payload.metrics.yearHistogram,
  titles: payload.titles.slice(0, options.maxTitles).map((title) => ({
    year: title.year,
    timestamp: title.timestamp,
    title: title.title,
    archiveUrl: title.archiveUrl,
  })),
  computedAt: payload.computedAt ?? null,
});

const readEnvelope = async (response: Response): Promise<ArchiveRiskEnvelope> => {
  return await response.json() as ArchiveRiskEnvelope;
};

const isLookupEnvelope = (
  envelope: ArchiveRiskEnvelope,
): envelope is ArchiveRiskEnvelope & { ok: true; data: NonNullable<ArchiveRiskEnvelope['data']> } => {
  return envelope.ok === true
    && !!envelope.data
    && ('history' in envelope.data || envelope.data.state === 'miss');
};

export class ArchiveHistoryProvider implements Provider<HistoryData> {
  readonly name = 'history.provider';

  constructor(
    private readonly config: ArchiveHistoryConfig,
    private readonly options: ProviderRuntimeOptions,
  ) {}

  async run(ctx: CrawlContext) {
    const startedAt = Date.now();
    if (!this.config.enabled || !this.config.baseUrl) {
      return providerFailure(this.name, startedAt, 'ARCHIVE_HISTORY_DISABLED', 'Archive history provider is disabled');
    }

    const baseUrl = this.config.baseUrl.replace(/\/+$/u, '');
    const lookupUrl = `${baseUrl}/api/lookup/${encodeURIComponent(ctx.domain)}`;

    try {
      const initialResponse = await fetchWithRetry(lookupUrl, {
        timeoutMs: this.config.timeoutMs,
        retryAttempts: this.options.retryAttempts ?? 0,
        retryBaseMs: this.options.retryBaseMs ?? 250,
        requestInit: {
          method: 'GET',
          headers: {
            accept: 'application/json',
          },
        },
      });
      let envelope = await readEnvelope(initialResponse);
      let cacheHit = true;

      if (!isLookupEnvelope(envelope)) {
        return providerFailure(
          this.name,
          startedAt,
          'ARCHIVE_HISTORY_INVALID_RESPONSE',
          typeof envelope.error?.message === 'string' ? envelope.error.message : 'Archive history lookup returned an unexpected envelope',
        );
      }

      if (envelope.data.state === 'miss' && this.config.computeOnMiss && this.config.apiKey) {
        const computeResponse = await fetchWithRetry(`${lookupUrl}/compute`, {
          timeoutMs: this.config.timeoutMs,
          retryAttempts: 0,
          retryBaseMs: 1,
          requestInit: {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              'x-api-key': this.config.apiKey,
            },
            body: JSON.stringify({
              computeGrant: '',
              turnstileToken: '',
            }),
          },
        });
        envelope = await readEnvelope(computeResponse);
        cacheHit = false;

        if (!isLookupEnvelope(envelope)) {
          return providerFailure(
            this.name,
            startedAt,
            'ARCHIVE_HISTORY_INVALID_RESPONSE',
            typeof envelope.error?.message === 'string' ? envelope.error.message : 'Archive history compute returned an unexpected envelope',
          );
        }
      }

      const history = envelope.data.history ?? null;
      if (!history) {
        return providerSuccess(this.name, startedAt, missPayload());
      }

      return providerSuccess(
        this.name,
        startedAt,
        mapArchiveRiskToHistoryData(history, {
          maxTitles: this.config.maxTitles,
          cacheHit,
        }),
      );
    } catch (error) {
      return providerFailure(
        this.name,
        startedAt,
        normalizeHistoryErrorCode(error),
        error instanceof Error ? error.message : 'Archive history provider failed',
      );
    }
  }
}
