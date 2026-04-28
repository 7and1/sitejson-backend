import { TrafficProvider } from '../traffic.provider.js';

const provider = new TrafficProvider({
  timeoutMs: 15000,
  retryAttempts: 2,
  retryBaseMs: 500,
});

const ctx = {
  domain: 'github.com',
  url: 'https://github.com',
  traceId: 'trc_debug_traffic',
  startedAt: Date.now(),
};

const result = await provider.run(ctx);
console.log('Result:', JSON.stringify(result, null, 2));
