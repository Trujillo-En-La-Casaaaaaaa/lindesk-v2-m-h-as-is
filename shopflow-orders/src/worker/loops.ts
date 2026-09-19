/**
 * The two background loops of this service.
 *
 * Both are plain `setInterval` loops with a re-entrancy guard, both are configured by an interval and
 * both are disabled by a non-positive interval - that is how the unit tests keep the runtime free of
 * timers and how the composed runtime runs them every second.
 *
 * The handles are unref'ed so they never keep the process alive; `stop()` waits for the pass in
 * flight, which is what a graceful shutdown needs before the pool is closed.
 */

import { errorDetail, type ErrorLogger } from '../logging.js';
import type { OutboxDispatcher } from '../application/saga/outbox-dispatcher.js';
import type { SagaRecoveryService } from '../application/saga/saga-recovery-service.js';

export interface WorkerHandle {
  /** Stops the loop and resolves when the pass in flight has finished. */
  stop(): Promise<void>;
  /** True when the loop actually runs (a non-positive interval creates an inert handle). */
  readonly enabled: boolean;
}

export interface WorkerOptions {
  readonly intervalMs: number;
  readonly logError?: ErrorLogger | undefined;
}

const inert: WorkerHandle = { enabled: false, stop: () => Promise.resolve() };

function startLoop(
  options: WorkerOptions,
  name: string,
  pass: () => Promise<unknown>,
  logError: ErrorLogger | undefined,
): WorkerHandle {
  if (options.intervalMs <= 0) {
    return inert;
  }

  let running = false;
  let inFlight: Promise<void> = Promise.resolve();

  const run = (): void => {
    if (running) {
      // The previous pass is still going: never stack passes.
      return;
    }
    running = true;
    inFlight = Promise.resolve()
      .then(pass)
      .then(() => undefined)
      .catch((error: unknown) => {
        logError?.(`the ${name} pass failed`, error);
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(run, options.intervalMs);
  timer.unref();

  return {
    enabled: true,
    stop: async () => {
      clearInterval(timer);
      await inFlight;
    },
  };
}

export function startSagaRecoveryWorker(
  recovery: SagaRecoveryService,
  options: WorkerOptions & { logError?: ErrorLogger | undefined },
): WorkerHandle {
  return startLoop(options, 'order-creation saga recovery', () => recovery.recoverOnce(), options.logError);
}

export function startOutboxDispatchWorker(
  dispatcher: OutboxDispatcher,
  options: WorkerOptions & { logError?: ErrorLogger | undefined },
): WorkerHandle {
  return startLoop(options, 'notification outbox dispatch', () => dispatcher.dispatchDue(), options.logError);
}

export { errorDetail };
