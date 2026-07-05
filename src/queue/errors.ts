const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? '');
};

export class QueueCapacityError extends Error {
  constructor(message = 'Queue capacity temporarily exhausted.', options?: { cause?: unknown }) {
    super(message);
    this.name = 'QueueCapacityError';
    if (options && 'cause' in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export const isRedisQueueCapacityErrorMessage = (message: string): boolean => {
  const normalized = message.trim();
  if (!normalized) {
    return false;
  }

  if (/OOM command not allowed/i.test(normalized)) {
    return true;
  }

  return /maxmemory/i.test(normalized) && /noeviction/i.test(normalized);
};

export const asQueueCapacityError = (error: unknown): QueueCapacityError | null => {
  if (error instanceof QueueCapacityError) {
    return error;
  }

  const message = getErrorMessage(error);
  if (!isRedisQueueCapacityErrorMessage(message)) {
    return null;
  }

  return new QueueCapacityError(message, { cause: error });
};

export const isQueueCapacityError = (error: unknown): error is QueueCapacityError =>
  error instanceof QueueCapacityError;
