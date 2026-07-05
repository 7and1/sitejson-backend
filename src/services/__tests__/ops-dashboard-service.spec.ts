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
    expect(data.alerts).toEqual([]);
    expect(data.queue_by_type?.browser_realtime).toBeDefined();
  });

  it('emits queue alerts when failed jobs are present', async () => {
    const jobs = new InMemoryJobRepository();
    const queue = new InMemoryJobQueue();

    queue.getAllCounts = async () => ({
      ingest: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 },
      browser_realtime: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 },
      browser: { waiting: 0, active: 0, completed: 0, failed: 3, delayed: 0, prioritized: 0 },
      async: { waiting: 0, active: 0, completed: 0, failed: 1, delayed: 0, prioritized: 0 },
      radar: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 },
      traffic: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 },
      whois: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0 },
    });

    const service = new OpsDashboardService(jobs, queue);
    const data = await service.getDashboard({
      window: '1h',
      recentLimit: 10,
    });

    expect(data.alerts).toEqual([
      expect.objectContaining({ queue: 'browser', failed: 3 }),
      expect.objectContaining({ queue: 'async', failed: 1 }),
    ]);
  });
});
