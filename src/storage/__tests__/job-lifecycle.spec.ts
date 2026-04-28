import { describe, expect, it } from 'vitest';
import { InMemoryJobRepository } from '../in-memory.js';

describe('InMemoryJobRepository lifecycle helpers', () => {
  it('transitions pending job to running and completed', async () => {
    const jobs = new InMemoryJobRepository();
    const now = new Date().toISOString();

    await jobs.create({
      id: 'job-1',
      domain: 'example.com',
      status: 'pending',
      priority: 'normal',
      progress: 0,
      stage: 'queued',
      traceId: 'trace-1',
      createdAt: now,
      updatedAt: now,
    });

    await jobs.markRunning('job-1', 'browser_running', 40);
    const running = await jobs.getById('job-1');
    expect(running?.status).toBe('running');
    expect(running?.stage).toBe('browser_running');
    expect(running?.progress).toBe(40);

    await jobs.markCompleted('job-1', 'browser_completed', 100);
    const completed = await jobs.getById('job-1');
    expect(completed?.status).toBe('completed');
    expect(completed?.stage).toBe('browser_completed');
    expect(completed?.progress).toBe(100);
  });

  it('does not override terminal completed state', async () => {
    const jobs = new InMemoryJobRepository();
    const now = new Date().toISOString();

    await jobs.create({
      id: 'job-2',
      domain: 'example.com',
      status: 'pending',
      priority: 'normal',
      progress: 0,
      stage: 'queued',
      traceId: 'trace-2',
      createdAt: now,
      updatedAt: now,
    });

    await jobs.markCompleted('job-2', 'done', 100);
    await jobs.markFailed('job-2', 'late failure', 'failed');
    await jobs.markRunning('job-2', 'running_again', 10);

    const job = await jobs.getById('job-2');
    expect(job?.status).toBe('completed');
    expect(job?.stage).toBe('done');
    expect(job?.errorMessage).toBeUndefined();
  });
});
