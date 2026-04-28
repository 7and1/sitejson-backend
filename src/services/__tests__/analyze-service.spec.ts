import { describe, expect, it } from 'vitest';
import { InMemoryJobQueue } from '../../queue/in-memory.js';
import { createLogger } from '../../observability/logger.js';
import { AnalyzeService } from '../analyze-service.js';
import { InMemoryCrawlTargetRepository, InMemoryJobRepository, InMemorySiteRepository } from '../../storage/in-memory.js';
import type { QueueJobPayload } from '../../queue/interfaces.js';
import type { QueueName } from '../../queue/names.js';

class FailingEnqueueQueue extends InMemoryJobQueue {
  async enqueue(_payload: QueueJobPayload, _queueName?: QueueName): Promise<void> {
    throw new Error('QUEUE_DOWN');
  }
}

describe('AnalyzeService', () => {
  it('returns ALREADY_FRESH for recent records', async () => {
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const crawlTargets = new InMemoryCrawlTargetRepository();
    const queue = new InMemoryJobQueue();
    const service = new AnalyzeService(jobs, sites, crawlTargets, queue, createLogger('error'), 3600, 1, false);

    await sites.upsert({
      domain: 'example.com',
      updatedAt: new Date().toISOString(),
      freshnessTtlSec: 3600,
    });

    const result = await service.schedule('example.com');
    expect(result.accepted).toBe(true);
    expect(result.reason).toBe('ALREADY_FRESH');
    expect(result.jobId).toBeNull();
  });

  it('queues a job when report is stale', async () => {
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const crawlTargets = new InMemoryCrawlTargetRepository();
    const queue = new InMemoryJobQueue();
    const service = new AnalyzeService(jobs, sites, crawlTargets, queue, createLogger('error'), 1, 1, false);

    await sites.upsert({
      domain: 'example.com',
      updatedAt: new Date(Date.now() - 5000).toISOString(),
      freshnessTtlSec: 1,
    });

    const result = await service.schedule('example.com', false, false, 'high');
    expect(result.accepted).toBe(true);
    expect(result.reason).toBe('QUEUED');
    expect(result.priority).toBe('high');
    expect(result.jobId).toMatch(/^job_/);
  });

  it('returns existing running job when duplicate scheduling happens', async () => {
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const crawlTargets = new InMemoryCrawlTargetRepository();
    const queue = new InMemoryJobQueue();
    const service = new AnalyzeService(jobs, sites, crawlTargets, queue, createLogger('error'), 1, 2, true);

    const first = await service.schedule('example.com', true, false, 'normal');
    const second = await service.schedule('example.com', true, false, 'normal');

    expect(first.accepted).toBe(true);
    expect(first.reason).toBe('QUEUED');
    expect(first.jobId).toMatch(/^job_/);

    expect(second.accepted).toBe(false);
    expect(second.reason).toBe('JOB_ALREADY_RUNNING');
    expect(second.jobId).toBe(first.jobId);
  });

  it('passes default skip_ai and prompt version to queue payload', async () => {
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const crawlTargets = new InMemoryCrawlTargetRepository();
    const queue = new InMemoryJobQueue();
    const service = new AnalyzeService(jobs, sites, crawlTargets, queue, createLogger('error'), 1, 7, true);

    const result = await service.schedule('example.com', true, false, 'normal');
    expect(result.accepted).toBe(true);

    let captured: any;
    await queue.consume('ingest', async (payload) => {
      captured = payload;
    });

    expect(captured.skipAi).toBe(true);
    expect(captured.dispatchLane).toBe('realtime');
    expect(captured.taxonomyPromptVersion).toBe(7);
  });

  it('marks job failed when enqueue throws and allows later retry', async () => {
    const jobs = new InMemoryJobRepository();
    const sites = new InMemorySiteRepository();
    const crawlTargets = new InMemoryCrawlTargetRepository();
    const service = new AnalyzeService(jobs, sites, crawlTargets, new FailingEnqueueQueue(), createLogger('error'), 1, 1, false);

    await expect(service.schedule('example.com', true, false, 'normal')).rejects.toThrow('QUEUE_DOWN');

    const failedJob = await jobs.findRunningByDomain('example.com');
    expect(failedJob).toBeNull();

    const retryService = new AnalyzeService(jobs, sites, crawlTargets, new InMemoryJobQueue(), createLogger('error'), 1, 1, false);
    const retried = await retryService.schedule('example.com', true, false, 'normal');
    expect(retried.accepted).toBe(true);
    expect(retried.reason).toBe('QUEUED');
  });
});
