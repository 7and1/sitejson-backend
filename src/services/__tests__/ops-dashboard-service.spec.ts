import { describe, expect, it } from 'vitest';
import { InMemoryJobQueue } from '../../queue/in-memory.js';
import { InMemoryJobRepository } from '../../storage/in-memory.js';
import { OpsDashboardService } from '../ops-dashboard-service.js';

describe('OpsDashboardService', () => {
  it('aggregates queue, jobs and recent items', async () => {
    const jobs = new InMemoryJobRepository();
    const queue = new InMemoryJobQueue();

    await jobs.create({
      id: 'job_completed',
      domain: 'example.com',
      status: 'completed',
      priority: 'normal',
      progress: 100,
      stage: 'done',
      traceId: 'trace-1',
      createdAt: new Date(Date.now() - 30_000).toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await jobs.create({
      id: 'job_failed',
      domain: 'failed.com',
      status: 'failed',
      priority: 'high',
      progress: 50,
      stage: 'failed',
      traceId: 'trace-2',
      createdAt: new Date(Date.now() - 20_000).toISOString(),
      updatedAt: new Date().toISOString(),
      errorMessage: 'network error',
    });

    await queue.enqueue({
      jobId: 'queued_job',
      domain: 'queued.com',
      traceId: 'trace-3',
    });

    const service = new OpsDashboardService(jobs, queue);
    const data = await service.getDashboard({
      window: '1h',
      recentLimit: 10,
    });

    expect(data.window).toBe('1h');
    expect(data.queue.waiting).toBe(1);
    expect(data.queue.prioritized).toBe(0);
    expect(data.jobs.created_total).toBe(2);
    expect(data.jobs.completed).toBe(1);
    expect(data.jobs.failed).toBe(1);
    expect(data.jobs.success_rate).toBe(0.5);
    expect(data.quality.traffic_coverage).toBe(0);
    expect(data.recent_items.length).toBe(2);
    expect(data.recent_items.find((item) => item.job_id === 'job_failed')?.error_message).toBe('network error');
    expect(data.queue_by_type?.browser_realtime).toBeDefined();
  });
});
