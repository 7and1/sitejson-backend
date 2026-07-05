import type { JobQueue } from '../queue/interfaces.js';
import type { QueueCounts } from '../queue/interfaces.js';
import type { DashboardJobStats, DashboardRecentJobItem, JobRepository } from '../storage/interfaces.js';

export type DashboardWindow = '1h';

export interface OpsDashboardQuery {
  window: DashboardWindow;
  recentLimit: number;
}

export interface OpsDashboardResponse {
  window: DashboardWindow;
  queue: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    prioritized: number;
  };
  jobs: {
    created_total: number;
    running: number;
    completed: number;
    failed: number;
    success_rate: number;
    avg_e2e_seconds: number;
  };
  quality: {
    traffic_coverage: number;
  };
  recent_items: Array<{
    job_id: string;
    domain: string;
    status: string;
    priority: string;
    stage?: string;
    rank: number | null;
    updated_at: string;
    error_message?: string;
  }>;
  generated_at: string;
  alerts: Array<{
    code: 'QUEUE_FAILED_JOBS';
    severity: 'warning';
    queue: string;
    failed: number;
    message: string;
  }>;
  queue_by_type?: Record<string, {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    prioritized: number;
  }>;
}

const WINDOW_TO_MS: Record<DashboardWindow, number> = {
  '1h': 60 * 60 * 1000,
};

const roundTo = (value: number, digits: number): number => {
  const base = 10 ** digits;
  return Math.round(value * base) / base;
};

const normalizeStats = (stats: DashboardJobStats) => {
  return {
    created_total: stats.createdTotal,
    running: stats.running,
    completed: stats.completed,
    failed: stats.failed,
    success_rate: roundTo(stats.successRate, 4),
    avg_e2e_seconds: roundTo(stats.avgE2eSeconds, 2),
  };
};

const normalizeQuality = (stats: DashboardJobStats) => {
  return {
    traffic_coverage: roundTo(stats.trafficCoverage, 4),
  };
};

const normalizeRecentItem = (item: DashboardRecentJobItem) => {
  return {
    job_id: item.jobId,
    domain: item.domain,
    status: item.status,
    priority: item.priority,
    stage: item.stage,
    rank: item.rank,
    updated_at: item.updatedAt,
    error_message: item.errorMessage,
  };
};

const aggregateQueueCounts = (entries: Iterable<QueueCounts>): QueueCounts => {
  const totals: QueueCounts = {
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
    prioritized: 0,
  };

  for (const counts of entries) {
    totals.waiting += counts.waiting;
    totals.active += counts.active;
    totals.completed += counts.completed;
    totals.failed += counts.failed;
    totals.delayed += counts.delayed;
    totals.prioritized += counts.prioritized;
  }

  return totals;
};

export const buildQueueFailureAlerts = (queueByType: Record<string, QueueCounts>) => {
  return Object.entries(queueByType)
    .filter(([, counts]) => counts.failed > 0)
    .sort((left, right) => right[1].failed - left[1].failed || left[0].localeCompare(right[0]))
    .map(([queueName, counts]) => ({
      code: 'QUEUE_FAILED_JOBS' as const,
      severity: 'warning' as const,
      queue: queueName,
      failed: counts.failed,
      message: `Queue ${queueName} has ${counts.failed} failed job${counts.failed === 1 ? '' : 's'} awaiting review or retry.`,
    }));
};

export class OpsDashboardService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly queue: JobQueue,
  ) {}

  async getDashboard(query: OpsDashboardQuery): Promise<OpsDashboardResponse> {
    const windowMs = WINDOW_TO_MS[query.window];
    const safeRecentLimit = Math.max(1, Math.min(100, Math.trunc(query.recentLimit)));

    const [queueByType, stats, recent] = await Promise.all([
      this.queue.getAllCounts(),
      this.jobs.getDashboardJobStats(windowMs),
      this.jobs.getRecentDashboardJobs(windowMs, safeRecentLimit),
    ]);
    const queueCounts = aggregateQueueCounts(Object.values(queueByType));

    return {
      window: query.window,
      queue: {
        waiting: queueCounts.waiting,
        active: queueCounts.active,
        completed: queueCounts.completed,
        failed: queueCounts.failed,
        delayed: queueCounts.delayed,
        prioritized: queueCounts.prioritized,
      },
      jobs: normalizeStats(stats),
      quality: normalizeQuality(stats),
      recent_items: recent.map(normalizeRecentItem),
      generated_at: new Date().toISOString(),
      alerts: buildQueueFailureAlerts(queueByType),
      queue_by_type: queueByType,
    };
  }
}
