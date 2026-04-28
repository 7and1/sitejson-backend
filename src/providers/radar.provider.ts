import type { CrawlContext, RadarSnapshot } from '../core/types.js';
import { providerFailure, providerSuccess } from './base.js';
import type { Provider } from './base.js';
import type { RadarData } from './types.js';
import type { RadarSnapshotRepository } from '../storage/interfaces.js';
import type { RadarSyncService } from '../services/radar-sync-service.js';

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

const isSnapshotStale = (snapshot: RadarSnapshot, ttlSec: number): boolean => {
  const updatedMs = new Date(snapshot.updatedAt).getTime();
  if (!Number.isFinite(updatedMs)) {
    return true;
  }

  return Date.now() - updatedMs > ttlSec * 1000;
};

export class RadarProvider implements Provider<RadarData> {
  readonly name = 'radar.provider';

  constructor(
    private readonly radarSnapshots: RadarSnapshotRepository,
    private readonly radarSyncService: RadarSyncService,
    private readonly ttlSec: number,
  ) {}

  async run(ctx: CrawlContext) {
    const startedAt = Date.now();

    try {
      const snapshot = await this.radarSnapshots.getByDomain(ctx.domain);

      if (!snapshot) {
        await this.radarSyncService.enqueue(ctx.domain, ctx.traceId);
        return providerSuccess(this.name, startedAt, {
          globalRank: null,
          rankBucket: undefined,
          categories: [],
          queued: true,
        });
      }

      const stale = isSnapshotStale(snapshot, this.ttlSec);
      if (stale) {
        await this.radarSyncService.enqueue(ctx.domain, ctx.traceId);
      }

      return providerSuccess(this.name, startedAt, {
        globalRank: snapshot.globalRank,
        rankBucket: snapshot.rankBucket ?? toRankBucket(snapshot.globalRank),
        categories: snapshot.categories,
        sourceTimestamp: snapshot.sourceTimestamp,
        queued: stale,
      });
    } catch (error) {
      return providerFailure(
        this.name,
        startedAt,
        'RADAR_READ_FAILED',
        error instanceof Error ? error.message : 'Radar provider failed',
      );
    }
  }
}
