import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import type { Logger } from '../observability/logger.js';

type Waiter = {
  resolve: (browser: Browser) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const ACQUIRE_TIMEOUT_MS = 30_000;

export class BrowserPool {
  private readonly pool: Browser[] = [];
  private readonly waiting: Waiter[] = [];
  private readonly pendingCloses = new Set<Promise<void>>();
  private readonly pendingOperations = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly size: number,
    private readonly logger: Logger,
  ) {}

  async init(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from({ length: this.size }, () => chromium.launch({ headless: true })),
    );

    let failed = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        this.pool.push(result.value);
      } else {
        failed++;
        this.logger.error({
          module: 'browser-pool',
          event: 'init_launch_failed',
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    if (this.pool.length === 0) {
      throw new Error(`BrowserPool init failed: all ${this.size} browser launches failed`);
    }

    this.logger.info({
      module: 'browser-pool',
      event: 'initialized',
      size: this.pool.length,
      requested: this.size,
      failed,
    });
  }

  async acquire(): Promise<Browser> {
    if (this.closed) {
      throw new Error('BrowserPool is closed');
    }

    const browser = this.pool.pop();
    if (browser) {
      if (browser.isConnected()) {
        return browser;
      }
      // Browser disconnected, launch a replacement
      this.logger.warn({ module: 'browser-pool', event: 'replacing_disconnected_browser' });
      try {
        const replacement = chromium.launch({ headless: true });
        this.trackOperation(replacement.then(
          async (fresh) => {
            if (this.closed) {
              await this.closeBrowser(fresh, 'close_acquire_replacement_after_shutdown_error');
            }
          },
          () => undefined,
        ));
        const fresh = await replacement;
        if (this.closed) {
          throw new Error('BrowserPool is closed');
        }
        return fresh;
      } catch (err) {
        if (this.closed && err instanceof Error && err.message === 'BrowserPool is closed') {
          throw err;
        }
        this.logger.error({
          module: 'browser-pool',
          event: 'replacement_launch_failed',
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    // No browser available — wait for one to be released, with timeout
    return new Promise<Browser>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiting.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.waiting.splice(idx, 1);
        reject(new Error(`BrowserPool acquire timed out after ${ACQUIRE_TIMEOUT_MS}ms`));
      }, ACQUIRE_TIMEOUT_MS);

      this.waiting.push({ resolve, reject, timer });
    });
  }

  release(browser: Browser): void {
    if (this.closed) {
      this.closeBrowser(browser, 'close_after_shutdown_error');
      return;
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      if (browser.isConnected()) {
        waiter.resolve(browser);
      } else {
        const replacement = chromium.launch({ headless: true }).then(
          async (fresh) => {
            if (this.closed) {
              await this.closeBrowser(fresh, 'close_replacement_after_shutdown_error');
              waiter.reject(new Error('BrowserPool is closed'));
              return;
            }
            waiter.resolve(fresh);
          },
          (err) => {
            this.logger.error({
              module: 'browser-pool',
              event: 'replacement_for_waiter_failed',
              error: err instanceof Error ? err.message : String(err),
            });
            waiter.reject(new Error('Failed to launch replacement browser'));
          },
        );
        this.trackOperation(replacement);
      }
      return;
    }

    if (browser.isConnected()) {
      this.pool.push(browser);
    } else {
      // Replace disconnected browser asynchronously to maintain pool size
      this.logger.warn({ module: 'browser-pool', event: 'replacing_dropped_browser', poolSize: this.pool.length });
      const replacement = chromium.launch({ headless: true }).then(
        async (fresh) => {
          if (!this.closed) {
            this.pool.push(fresh);
          } else {
            await this.closeBrowser(fresh, 'close_background_replacement_after_shutdown_error');
          }
        },
        (err) => {
          this.logger.error({
            module: 'browser-pool',
            event: 'background_replacement_failed',
            error: err instanceof Error ? err.message : String(err),
            poolSize: this.pool.length,
          });
        },
      );
      this.trackOperation(replacement);
    }
  }

  private trackOperation(operation: Promise<void>): void {
    this.pendingOperations.add(operation);
    operation.finally(() => {
      this.pendingOperations.delete(operation);
    });
  }

  private closeBrowser(browser: Browser, errorEvent: string): Promise<void> {
    const closePromise = browser.close()
      .catch((err) => {
        this.logger.debug({
          module: 'browser-pool',
          event: errorEvent,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    this.pendingCloses.add(closePromise);
    closePromise.finally(() => {
      this.pendingCloses.delete(closePromise);
    });
    return closePromise;
  }

  async close(): Promise<void> {
    this.closed = true;

    // Reject all pending waiters
    for (const waiter of this.waiting) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('BrowserPool is closed'));
    }
    this.waiting.length = 0;

    await Promise.allSettled(this.pool.map((b) => b.close()));
    this.pool.length = 0;
    while (this.pendingOperations.size > 0 || this.pendingCloses.size > 0) {
      await Promise.allSettled([
        ...Array.from(this.pendingOperations),
        ...Array.from(this.pendingCloses),
      ]);
    }
    this.logger.info({ module: 'browser-pool', event: 'closed' });
  }
}
