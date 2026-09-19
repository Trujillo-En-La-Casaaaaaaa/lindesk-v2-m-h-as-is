/**
 * The order-creation saga as it is persisted in `order_operations`.
 *
 * The state machine is the one of `design/order-creation-saga.md`, mapped onto the states the
 * authoritative DDL allows.
 *
 * ```text
 *   STARTED ──decrement 404──────────────────────────► ABORTED_NOT_FOUND          (terminal, no order)
 *           ──decrement 409 INSUFFICIENT_STOCK──────► ABORTED_INSUFFICIENT_STOCK (terminal, no order)
 *           ──decrement 2xx─────────────────────────► DECREMENTED
 *           ──decrement unanswerable────────────────► UNCERTAIN                    (resolved by the worker)
 *   DECREMENTED ──local commit──────────────────────► COMPLETED                  (terminal, order exists)
 *               ──local commit failed, release ok───► DECREMENTED + RELEASED      (terminal, no order)
 *   UNCERTAIN ──replayed decrement──────────────────► same branches as STARTED
 * ```
 *
 * `RELEASED` is the recorded decrement outcome after the compensating release succeeded: the saga is
 * then terminal and the worker must never complete it forward (`state` is `DECREMENTED` because the
 * decrement really was applied once, and the DDL deliberately knows the five saga states above plus
 * `UNCERTAIN`, not a second abort state).
 */

export type SagaState =
  | 'STARTED'
  | 'DECREMENTED'
  | 'COMPLETED'
  | 'ABORTED_NOT_FOUND'
  | 'ABORTED_INSUFFICIENT_STOCK'
  | 'UNCERTAIN';

/**
 * `RELEASED` is not an inventory *outcome* but the terminal *state* of the recorded decrement after
 * the compensating release; it is kept in this column so that a released saga is never mistaken for
 * a completable one (see the state diagram above).
 */
export type DecrementOutcome = 'DECREMENTED' | 'INSUFFICIENT_STOCK' | 'NOT_FOUND' | 'RELEASED';

/** One row of `order_operations`. */
export interface OrderOperation {
  readonly orderId: string;
  readonly state: SagaState;
  readonly productId: string;
  readonly quantity: number;
  readonly customerEmail: string;
  readonly clientIdempotencyKey: string | null;
  readonly unitPriceCents: number | null;
  readonly decrementOutcome: DecrementOutcome | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A saga row that is about to be inserted (`state = 'STARTED'`, `attempts = 0`). */
export interface NewOrderOperation {
  readonly orderId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly customerEmail: string;
  readonly clientIdempotencyKey: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A partial update of a saga row; every present field is written, `lastError` may be cleared. */
export interface OrderOperationUpdate {
  readonly state?: SagaState;
  readonly unitPriceCents?: number;
  readonly decrementOutcome?: DecrementOutcome;
  readonly attempts?: number;
  readonly lastError?: string | null;
}

/** The diagnostic view of `GET /orders/:id/operations`. */
export interface OrderOperationView {
  readonly orderId: string;
  readonly state: SagaState;
  readonly productId: string;
  readonly quantity: number;
  readonly customerEmail: string;
  readonly attempts: number;
  readonly decrementOutcome: DecrementOutcome | null;
  readonly notificationOutboxState: OutboxState | null;
  readonly updatedAt: string;
}

export type OutboxState = 'PENDING' | 'DELIVERED';

/** The state of a saga that the recovery worker must still look at (never a released or terminal one). */
export function isRecoverableState(state: SagaState): boolean {
  return state === 'STARTED' || state === 'DECREMENTED' || state === 'UNCERTAIN';
}

/** A completed decrement that was compensated: terminal, no order, never completed forward. */
export function isCompensated(operation: OrderOperation): boolean {
  return operation.state === 'DECREMENTED' && operation.decrementOutcome === 'RELEASED';
}

export function toOrderOperationView(
  operation: OrderOperation,
  notificationOutboxState: OutboxState | null,
): OrderOperationView {
  return {
    orderId: operation.orderId,
    state: operation.state,
    productId: operation.productId,
    quantity: operation.quantity,
    customerEmail: operation.customerEmail,
    attempts: operation.attempts,
    decrementOutcome: operation.decrementOutcome,
    notificationOutboxState,
    updatedAt: operation.updatedAt.toISOString(),
  };
}
