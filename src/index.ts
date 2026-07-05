import { buildApp } from './app.js';

const SHUTDOWN_TIMEOUT_MS = 30000;

const start = async () => {
  const runtime = await buildApp(undefined, { runtimeRole: 'api' });
  await runtime.app.listen({ port: runtime.env.PORT, host: '0.0.0.0' });
  runtime.logger.info({ module: 'server', event: 'started', port: runtime.env.PORT });

  // Warm the directory facet/stats caches in the background (does not block
  // serving) so the first requests after a (re)deploy don't all run the slow
  // aggregations at once and produce a cold-start burst of timeouts.
  if (runtime.env.DIRECTORY_CACHE_PREWARM_ENABLED) {
    void runtime.dependencies.sites
      .prewarmDirectoryCaches({ topSlugsPerType: runtime.env.DIRECTORY_CACHE_PREWARM_TOP_SLUGS })
      .then(() => runtime.logger.info({ module: 'server', event: 'directory_cache_prewarmed' }))
      .catch((error) => runtime.logger.warn({ module: 'server', event: 'directory_cache_prewarm_failed', error: String(error) }));
  }

  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    runtime.logger.info({ module: 'server', event: 'shutdown_started', signal });

    // Force exit after timeout
    const forceExitTimer = setTimeout(() => {
      runtime.logger.error({ module: 'server', event: 'shutdown_timeout', timeout_ms: SHUTDOWN_TIMEOUT_MS });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      await runtime.app.close();
      await runtime.close();
      runtime.logger.info({ module: 'server', event: 'shutdown_complete' });
    } finally {
      clearTimeout(forceExitTimer);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
