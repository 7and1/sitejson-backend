import type { Logger } from '../observability/logger.js';
import type { QueueJobPayload } from '../queue/interfaces.js';
import type { JobQueue } from '../queue/interfaces.js';
import { QUEUE_NAMES } from '../queue/names.js';

export class RadarSyncService {
  constructor(
    private readonly queue: JobQueue,
    private readonly logger: Logger,
  ) {}

  async enqueue(domain: string, traceId: string): Promise<void> {
    const payload: QueueJobPayload = {
      jobId: `radar_${domain}_${Date.now()}`,
      domain,
      traceId,
      purpose: 'radar-sync',
      phase: QUEUE_NAMES.radar,
      source: 'system',
    };

    await this.queue.enqueue(payload, QUEUE_NAMES.radar);

    this.logger.info({
      trace_id: traceId,
      domain,
      module: 'radar-sync-service',
      event: 'radar_sync_enqueued',
    });
  }
}
