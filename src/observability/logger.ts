import pino from 'pino';

export const createLogger = (level: string) => {
  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'authorization',
        'headers.authorization',
        'headers.x-api-key',
        'request.headers.authorization',
        'request.headers.x-api-key',
        '*.authorization',
        '*.apiKey',
        '*.api_key',
        '*.password',
        '*.secret',
        '*.token',
        'proxy.username',
        'proxy.password',
      ],
      censor: '[REDACTED]',
    },
  });
};

export type Logger = ReturnType<typeof createLogger>;
