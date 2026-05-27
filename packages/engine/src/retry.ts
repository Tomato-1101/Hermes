import type { RetryPolicy } from '@hermes/ir';

export function nextDelayMs(policy: RetryPolicy, attemptIndex: number): number {
  const backoff = policy.backoff;
  if (!backoff) return 0;
  if (backoff.kind === 'fixed') return backoff.initialMs;
  const factor = backoff.factor ?? 2;
  const ms = backoff.initialMs * Math.pow(factor, attemptIndex);
  return Math.min(ms, backoff.maxMs ?? Infinity);
}

export function shouldRetry(policy: RetryPolicy | undefined, errorClass: string | undefined): boolean {
  if (!policy) return false;
  if (!policy.retryOn || policy.retryOn.length === 0) return true;
  if (policy.retryOn.includes('any')) return true;
  if (!errorClass) return false;
  // The cast below is intentional: retryOn is a readonly tuple typed by IR.
  return (policy.retryOn as readonly string[]).includes(errorClass);
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new Error('aborted'));
    };
    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
