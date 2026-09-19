/**
 * The saga recovery worker body (resume-forward policy, `design/order-creation-saga.md`).
 *
 * It reads the persisted state - nothing is kept in process memory - and continues every unfinished
 * saga:
 *
 * | persisted state | what the worker does |
 * | --- | --- |
 * | `STARTED` (older than the grace period) | replays `POST /stock-decrements` with the same order id and follows the same branches as the inline flow |
 * | `UNCERTAIN` | the same replay, then completes forward or aborts deterministically |
 * | `DECREMENTED` without an order row | completes the local transaction, then dispatches the confirmation |
 * | `DECREMENTED` when the local commit cannot proceed | releases the decrement, then marks the saga compensated |
 *
 * A released saga (`decrement_outcome = 'RELEASED'`) is terminal: it is never completed forward.
 */

import { errorDetail, type ErrorLogger } from '../../logging.js';
import { isCompensated } from '../../domain/saga.js';
import type { OrderStore } from '../../ports/order-store.js';
import type { OrderCreationService } from './order-creation-service.js';

export interface SagaRecoveryDependencies {
  readonly store: OrderStore;
  readonly creation: OrderCreationService;
  /**
   * How long a `STARTED` saga must be untouched before the worker may take it over. It only has to
   * cover the in-flight inline attempt of a concurrent request.
   */
  readonly staleStartedGraceMs: number;
  readonly batchSize?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly logError?: ErrorLogger | undefined;
}

export interface RecoveryRun {
  readonly inspected: number;
  readonly advanced: number;
}

export class SagaRecoveryService {
  private readonly store: OrderStore;
  private readonly creation: OrderCreationService;
  private readonly staleStartedGraceMs: number;
  private readonly batchSize: number;
  private readonly now: () => Date;
  private readonly logError: ErrorLogger | undefined;

  constructor(dependencies: SagaRecoveryDependencies) {
    this.store = dependencies.store;
    this.creation = dependencies.creation;
    this.staleStartedGraceMs = dependencies.staleStartedGraceMs;
    this.batchSize = dependencies.batchSize ?? 25;
    this.now = dependencies.now ?? (() => new Date());
    this.logError = dependencies.logError;
  }

  /** One pass over the unfinished sagas. Never throws: a failed row is retried on the next pass. */
  async recoverOnce(): Promise<RecoveryRun> {
    const cutoff = new Date(this.now().getTime() - this.staleStartedGraceMs);
    const candidates = await this.store.listRecoverableOrderOperations(cutoff, this.batchSize);

    let advanced = 0;
    for (const operation of candidates) {
      if (isCompensated(operation)) {
        continue;
      }
      try {
        await this.creation.resolveOrderOperation(operation, 'worker');
        advanced += 1;
      } catch (error) {
        this.logError?.(
          `resolving the order-creation saga ${operation.orderId} (state ${operation.state}) failed`,
          error,
        );
        // The saga row keeps the failure: it is retried on the next pass.
        await this.store
          .updateOrderOperation(operation.orderId, { lastError: errorDetail(error) })
          .catch(() => undefined);
      }
    }

    return { inspected: candidates.length, advanced };
  }
}
