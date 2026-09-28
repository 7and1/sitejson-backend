import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from '../observability/logger.js';
import type { ActiveJob } from '../queue/interfaces.js';
import { QUEUE_NAMES, type QueueName } from '../queue/names.js';

export const HEARTBEAT_INTERVAL_MS = 10_000;

// A job running this long is wedged, not slow. Over 72h of production logs
// (2026-09-28) the slowest browser job took 245s and the slowest io job 61s;
// the worker that motivated this sat on one job for ~10h while its heartbeat
// stayed green. BullMQ keeps renewing the lock while the process lives, so a
// wedged job never stalls on its own.
export const DEFAULT_STUCK_JOB_AFTER_MS = 30 * 60_000;

const STUCK_JOB_AFTER_MS: Partial<Record<QueueName, number>> = {
  // Radar bulk CSV imports hold a 1h lock by design.
  [QUEUE_NAMES.radar]: 2 * 60 * 60_000,
};

export const stuckJobAfterMs = (queueName: QueueName): number =>
  STUCK_JOB_AFTER_MS[queueName] ?? DEFAULT_STUCK_JOB_AFTER_MS;

export type StuckJob = ActiveJob & { ageMs: number };

/** The oldest active job that has outlived its queue's budget, or null. */
export const findStuckJob = (activeJobs: ActiveJob[], now: number): StuckJob | null => {
  let stuck: StuckJob | null = null;
  for (const job of activeJobs) {
    const ageMs = now - job.startedAt;
    if (ageMs > stuckJobAfterMs(job.queueName) && (!stuck || ageMs > stuck.ageMs)) {
      stuck = { ...job, ageMs };
    }
  }
  return stuck;
};

// The heartbeat means "making progress", not just "event loop alive": once a job
// outlives its queue's budget the heartbeat stops (container turns unhealthy)
// and onStuck restarts the worker, because nothing on the host acts on unhealthy.
export const startHeartbeat = (
  filePath: string | undefined,
  logger: Logger,
  getActiveJobs: () => ActiveJob[],
  onStuck: (job: StuckJob) => void,
): ReturnType<typeof setInterval> => {
  let stuckReported = false;

  const tick = async () => {
    const stuck = findStuckJob(getActiveJobs(), Date.now());
    if (stuck) {
      if (!stuckReported) {
        stuckReported = true;
        logger.fatal({
          module: 'worker',
          event: 'worker_stuck_job',
          queue: stuck.queueName,
          job_id: stuck.jobId,
          age_ms: stuck.ageMs,
        });
        onStuck(stuck);
      }
      return;
    }
    if (!filePath) return;

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `${new Date().toISOString()}\n`, { mode: 0o644 });
    } catch (error) {
      logger.warn({
        module: 'worker',
        event: 'heartbeat_write_failed',
        file: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return timer;
};
