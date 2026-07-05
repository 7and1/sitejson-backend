import { describe, expect, it, vi } from 'vitest';

vi.mock('pg', () => ({
  Pool: class {},
}));

import { ensurePostgresSchema } from '../postgres.js';

describe('ensurePostgresSchema autovacuum tuning', () => {
  it('applies table-level autovacuum settings for high-churn tables', async () => {
    const query = vi.fn(async (..._args: unknown[]) => ({}));
    const release = vi.fn();
    const connect = vi.fn(async () => ({
      query,
      release,
    }));

    await ensurePostgresSchema({ connect } as any);

    const sql = query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('ALTER TABLE crawl_targets');
    expect(sql).toContain('autovacuum_vacuum_scale_factor = 0.02');
    expect(sql).toContain('autovacuum_analyze_scale_factor = 0.01');
    expect(sql).toContain('ALTER TABLE site_profiles');
    expect(sql).toContain('autovacuum_vacuum_scale_factor = 0.05');
    expect(sql).toContain('ALTER TABLE radar_snapshots');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
