import { vi } from 'vitest';

type QueryFn = (sql: string, params?: unknown[]) => Promise<unknown>;

const isTransactionControl = (sql: string) =>
  /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || sql.startsWith('SELECT set_config');

/**
 * Minimal pg Pool stand-in: pool.query and connected clients both route data
 * queries to `query`; transaction control and set_config calls are recorded in
 * `control` so tests can assert per-transaction settings.
 */
export const fakePgPool = (query: QueryFn) => {
  const control: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    query,
    connect: vi.fn(async () => ({
      query: (sql: string, params?: unknown[]) => {
        if (isTransactionControl(sql)) {
          control.push({ sql, params });
          return Promise.resolve({ rows: [] });
        }
        return query(sql, params);
      },
      release: vi.fn(),
    })),
  };
  return { pool: pool as any, control };
};
