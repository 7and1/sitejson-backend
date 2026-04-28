import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import type { RadarSnapshot } from '../core/types.js';
import type { Logger } from '../observability/logger.js';
import { fetchWithRetry } from '../providers/http.js';
import type { JobQueue, QueueJobPayload } from '../queue/interfaces.js';
import { QUEUE_NAMES } from '../queue/names.js';
import type { CrawlTargetRepository, JobRepository, RadarSnapshotRepository } from '../storage/interfaces.js';

type RadarDomainResponse = {
  result?: {
    details_0?: {
      rank?: number;
      bucket?: string;
      categories?: Array<{ name?: string }>;
    };
  };
};

type RadarDatasetListResponse = {
  result?: {
    datasets?: Array<{
      id: number;
      title?: string;
      url?: string;
    }>;
  };
};

type RadarDatasetDownloadResponse = {
  result?: {
    dataset?: {
      url?: string;
    };
  };
};

type CsvParseMode = 'rank_domain' | 'domain_rank' | 'domain_only';

type CsvParseState = {
  mode: CsvParseMode | null;
  headerDetected: boolean;
  rawRows: number;
  dataRows: number;
  validRows: number;
  skippedRows: number;
  skippedInvalidRows: number;
};

const toRankBucket = (rank: number | null | undefined): string | undefined => {
  if (typeof rank !== 'number' || !Number.isFinite(rank) || rank <= 0) {
    return undefined;
  }

  if (rank <= 100) return 'Top 100';
  if (rank <= 1000) return 'Top 1k';
  if (rank <= 10000) return 'Top 10k';
  if (rank <= 100000) return 'Top 100k';
  return 'Global';
};

const normalizeCsvCell = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
};

const parsePositiveInt = (value: string | undefined): number | null => {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const normalizeDomain = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }

  const normalized = normalizeCsvCell(value).toLowerCase().replace(/\.$/, '');
  if (!normalized || normalized.includes('..') || normalized.startsWith('.') || normalized.endsWith('.')) {
    return null;
  }

  if (!normalized.includes('.')) {
    return null;
  }

  if (!/^[a-z0-9.-]+$/.test(normalized)) {
    return null;
  }

  return normalized;
};

const detectModeFromHeader = (cells: string[]): CsvParseMode | null => {
  const first = cells[0]?.toLowerCase() ?? '';
  const second = cells[1]?.toLowerCase() ?? '';

  if (first.includes('rank') && second.includes('domain')) {
    return 'rank_domain';
  }

  if (first.includes('domain') && second.includes('rank')) {
    return 'domain_rank';
  }

  if (first.includes('domain') && cells.length === 1) {
    return 'domain_only';
  }

  return null;
};

const detectModeFromData = (cells: string[]): CsvParseMode | null => {
  const firstRank = parsePositiveInt(cells[0]);
  const secondRank = parsePositiveInt(cells[1]);
  const firstDomain = normalizeDomain(cells[0]);
  const secondDomain = normalizeDomain(cells[1]);

  if (firstRank && secondDomain) {
    return 'rank_domain';
  }

  if (firstDomain && secondRank) {
    return 'domain_rank';
  }

  if (firstDomain) {
    return 'domain_only';
  }

  return null;
};

const parseCsvRow = (
  line: string,
  state: CsvParseState,
): { rank: number; domain: string } | null => {
  const trimmed = line.trim();
  if (!trimmed) {
    state.skippedRows += 1;
    return null;
  }

  const cells = trimmed.split(',').map((cell) => normalizeCsvCell(cell));

  if (!state.mode) {
    const modeFromHeader = detectModeFromHeader(cells);
    if (modeFromHeader) {
      state.mode = modeFromHeader;
      state.headerDetected = true;
      state.skippedRows += 1;
      return null;
    }

    state.mode = detectModeFromData(cells) ?? 'domain_only';
  }

  state.dataRows += 1;

  let rank: number | null = null;
  let domain: string | null = null;

  if (state.mode === 'rank_domain') {
    rank = parsePositiveInt(cells[0]);
    domain = normalizeDomain(cells[1]);
  } else if (state.mode === 'domain_rank') {
    domain = normalizeDomain(cells[0]);
    rank = parsePositiveInt(cells[1]);
  } else {
    domain = normalizeDomain(cells[0]);
    rank = state.dataRows;
  }

  if (!rank || !domain) {
    state.skippedRows += 1;
    state.skippedInvalidRows += 1;
    return null;
  }

  state.validRows += 1;
  return { rank, domain };
};

export class RadarSyncWorker {
  constructor(
    private readonly radarSnapshots: RadarSnapshotRepository,
    private readonly crawlTargets: CrawlTargetRepository,
    private readonly jobs: JobRepository,
    private readonly queue: JobQueue,
    private readonly logger: Logger,
    private readonly token?: string,
    private readonly datasetType: string = 'ranking_bucket',
    private readonly timeoutMs: number = 15000,
    private readonly retryAttempts: number = 2,
    private readonly retryBaseMs: number = 250,
    private readonly bulkBatchSize: number = 10_000,
  ) {}

  async process(payload: QueueJobPayload): Promise<void> {
    if (payload.purpose === 'radar-bulk-sync') {
      await this.processBulkCsv(payload.traceId);
      return;
    }

    if (payload.purpose !== 'radar-sync') {
      return;
    }

    await this.processSingleDomain(payload);
  }

  private async processSingleDomain(payload: QueueJobPayload): Promise<void> {
    const { domain, traceId, crawlJobId } = payload;

    if (crawlJobId) {
      await this.jobs.markRunning(crawlJobId, 'radar_running', 60);
    }

    if (!this.token) {
      await this.crawlTargets.markLayerResult(domain, 'radar', 'failed');
      if (crawlJobId) {
        await this.jobs.markFailed(crawlJobId, 'CLOUDFLARE_API_TOKEN missing', 'radar_failed');
      }
      this.logger.warn({
        trace_id: traceId,
        domain,
        module: 'radar-sync-worker',
        event: 'token_missing',
      });
      return;
    }

    try {
      const response = await fetchWithRetry(
        `https://api.cloudflare.com/client/v4/radar/ranking/domain/${encodeURIComponent(domain)}`,
        {
          timeoutMs: this.timeoutMs,
          retryAttempts: this.retryAttempts,
          retryBaseMs: this.retryBaseMs,
          requestInit: {
            headers: {
              authorization: `Bearer ${this.token}`,
              accept: 'application/json',
            },
          },
        },
      );

      const payloadJson = (await response.json()) as RadarDomainResponse;
      const details = payloadJson.result?.details_0;
      const rank = typeof details?.rank === 'number' ? details.rank : null;
      const categories = (details?.categories ?? [])
        .map((item) => item.name)
        .filter((item): item is string => typeof item === 'string' && item.length > 0);

      await this.radarSnapshots.upsert({
        domain,
        globalRank: rank,
        rankBucket: details?.bucket ?? toRankBucket(rank),
        categories,
        sourceTimestamp: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await this.crawlTargets.markLayerResult(domain, 'radar', 'success');
      if (crawlJobId) {
        await this.jobs.markRunning(crawlJobId, 'radar_completed', 70);
      }

      this.logger.info({
        trace_id: traceId,
        domain,
        module: 'radar-sync-worker',
        event: 'snapshot_updated',
        rank,
      });
    } catch (error) {
      await this.crawlTargets.markLayerResult(domain, 'radar', 'failed');
      if (crawlJobId) {
        await this.jobs.markFailed(
          crawlJobId,
          error instanceof Error ? error.message : String(error),
          'radar_failed',
        );
      }
      this.logger.error({
        trace_id: traceId,
        domain,
        module: 'radar-sync-worker',
        event: 'snapshot_update_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async processBulkCsv(traceId: string): Promise<void> {
    if (!this.token) {
      this.logger.warn({
        trace_id: traceId,
        module: 'radar-sync-worker',
        event: 'bulk_csv_token_missing',
      });
      return;
    }

    this.logger.info({
      trace_id: traceId,
      module: 'radar-sync-worker',
      event: 'bulk_csv_started',
      dataset_type: this.datasetType,
      batch_size: this.bulkBatchSize,
    });

    try {
      const datasetUrl = await this.getDatasetDownloadUrl(traceId);
      if (!datasetUrl) {
        this.logger.warn({
          trace_id: traceId,
          module: 'radar-sync-worker',
          event: 'bulk_csv_no_dataset',
          dataset_type: this.datasetType,
        });
        return;
      }

      const response = await fetch(datasetUrl, {
        signal: AbortSignal.timeout(3_600_000),
      });

      if (!response.ok || !response.body) {
        this.logger.error({
          trace_id: traceId,
          module: 'radar-sync-worker',
          event: 'bulk_csv_download_failed',
          status: response.status,
        });
        return;
      }

      const parseState: CsvParseState = {
        mode: null,
        headerDetected: false,
        rawRows: 0,
        dataRows: 0,
        validRows: 0,
        skippedRows: 0,
        skippedInvalidRows: 0,
      };

      let batch: Array<{ rank: number; domain: string }> = [];
      let totalProcessed = 0;
      let totalNew = 0;

      const nodeStream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
      const rl = createInterface({ input: nodeStream, crlfDelay: Infinity });

      for await (const line of rl) {
        parseState.rawRows += 1;
        const row = parseCsvRow(line, parseState);
        if (!row) {
          continue;
        }

        batch.push(row);

        if (batch.length >= this.bulkBatchSize) {
          const newCount = await this.processBatch(batch, traceId);
          totalNew += newCount;
          totalProcessed += batch.length;
          batch = [];

          if (totalProcessed % 100_000 === 0) {
            this.logger.info({
              trace_id: traceId,
              module: 'radar-sync-worker',
              event: 'bulk_csv_progress',
              processed: totalProcessed,
              new_domains: totalNew,
              parse_mode: parseState.mode,
              skipped_rows: parseState.skippedRows,
            });
          }
        }
      }

      if (batch.length > 0) {
        const newCount = await this.processBatch(batch, traceId);
        totalNew += newCount;
        totalProcessed += batch.length;
      }

      this.logger.info({
        trace_id: traceId,
        module: 'radar-sync-worker',
        event: 'bulk_csv_completed',
        total_processed: totalProcessed,
        total_new: totalNew,
        raw_rows: parseState.rawRows,
        valid_rows: parseState.validRows,
        skipped_rows: parseState.skippedRows,
        skipped_invalid_rows: parseState.skippedInvalidRows,
        parse_mode: parseState.mode ?? 'domain_only',
        header_detected: parseState.headerDetected,
      });
    } catch (error) {
      this.logger.error({
        trace_id: traceId,
        module: 'radar-sync-worker',
        event: 'bulk_csv_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async getDatasetDownloadUrl(traceId: string): Promise<string | null> {
    try {
      const response = await fetchWithRetry(
        `https://api.cloudflare.com/client/v4/radar/datasets?datasetType=${this.datasetType}&limit=1&format=json`,
        {
          timeoutMs: this.timeoutMs,
          retryAttempts: this.retryAttempts,
          retryBaseMs: this.retryBaseMs,
          requestInit: {
            headers: {
              authorization: `Bearer ${this.token}`,
              accept: 'application/json',
            },
          },
        },
      );

      const data = (await response.json()) as RadarDatasetListResponse;
      const dataset = data.result?.datasets?.[0];

      if (!dataset?.id) {
        this.logger.warn({
          trace_id: traceId,
          module: 'radar-sync-worker',
          event: 'dataset_not_found',
          dataset_type: this.datasetType,
        });
        return null;
      }

      this.logger.info({
        trace_id: traceId,
        module: 'radar-sync-worker',
        event: 'dataset_selected',
        dataset_id: dataset.id,
        dataset_title: dataset.title,
        dataset_type: this.datasetType,
      });

      const downloadResponse = await fetchWithRetry(
        `https://api.cloudflare.com/client/v4/radar/datasets/download`,
        {
          timeoutMs: this.timeoutMs,
          retryAttempts: this.retryAttempts,
          retryBaseMs: this.retryBaseMs,
          requestInit: {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ datasetId: dataset.id }),
          },
        },
      );

      const downloadData = (await downloadResponse.json()) as RadarDatasetDownloadResponse;
      const downloadUrl = downloadData.result?.dataset?.url ?? dataset.url ?? null;
      if (!downloadUrl) {
        this.logger.warn({
          trace_id: traceId,
          module: 'radar-sync-worker',
          event: 'dataset_download_url_missing',
          dataset_id: dataset.id,
        });
      }

      return downloadUrl;
    } catch (error) {
      this.logger.error({
        trace_id: traceId,
        module: 'radar-sync-worker',
        event: 'dataset_url_fetch_failed',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async processBatch(
    batch: Array<{ rank: number; domain: string }>,
    traceId: string,
  ): Promise<number> {
    const rankByDomain = new Map<string, number>();
    for (const item of batch) {
      rankByDomain.set(item.domain, item.rank);
    }

    const normalizedBatch = Array.from(rankByDomain.entries()).map(([domain, rank]) => ({ domain, rank }));
    const domains = normalizedBatch.map((item) => item.domain);
    const existingDomains = await this.crawlTargets.getExistingDomains(domains);

    const newDomains = normalizedBatch.filter((item) => !existingDomains.has(item.domain));
    const existingDomainRanks = normalizedBatch.filter((item) => existingDomains.has(item.domain));

    if (newDomains.length > 0) {
      await this.crawlTargets.bulkUpsert(newDomains.map((item) => ({
        domain: item.domain,
        priority: item.rank <= 100_000 ? 2 : 1,
        radarRank: item.rank,
      })));
    }

    if (existingDomainRanks.length > 0) {
      await this.crawlTargets.bulkUpdateRadarRank(existingDomainRanks.map((item) => ({
        domain: item.domain,
        radarRank: item.rank,
      })));
    }

    const now = new Date().toISOString();
    const snapshots: RadarSnapshot[] = normalizedBatch.map((item) => ({
      domain: item.domain,
      globalRank: item.rank,
      rankBucket: toRankBucket(item.rank),
      categories: [],
      sourceTimestamp: now,
      updatedAt: now,
    }));
    await this.radarSnapshots.bulkUpsert(snapshots);

    if (newDomains.length > 0) {
      const browserPayloads: QueueJobPayload[] = newDomains
        .filter((item) => item.rank <= 1_000_000)
        .map((item) => ({
          jobId: randomUUID(),
          domain: item.domain,
          traceId,
          source: 'system',
          dispatchLane: 'background',
          phase: QUEUE_NAMES.browser,
          purpose: 'browser',
          isHighValue: item.rank <= 100_000,
        }));

      if (browserPayloads.length > 0) {
        await this.queue.enqueueBulk(browserPayloads, QUEUE_NAMES.browser);
        await Promise.allSettled(
          browserPayloads.map((item) => this.crawlTargets.update(item.domain, { lastBrowserStatus: 'pending' })),
        );
      }
    }

    return newDomains.length;
  }
}
