/**
 * The persistence port of this service.
 *
 * One port, implemented twice: the PostgreSQL adapter (production, and the integration tests) and the
 * in-memory double used by the unit tests. `OrderUnitOfWork` runs a use case in one local transaction
 * on a store bound to that transaction, which is how the order row, the outbox row and the saga
 * completion commit together (step 8 of `design/order-creation-saga.md`).
 *
 * The port only knows the three tables this service owns (`orders`, `order_operations`,
 * `notification_outbox`); stock and the product catalog belong to `shopflow-inventory`.
 */

import type { Order } from '../domain/order.js';
import type { NewOutboxEntry, OutboxEntry, OutboxEntryUpdate } from '../domain/outbox.js';
import type { NewOrderOperation, OrderOperation, OrderOperationUpdate } from '../domain/saga.js';

/** The outcome of the single conditional statement of `POST /orders/:id/ship`. */
export type ShipOutcome =
  | { readonly kind: 'SHIPPED'; readonly order: Order }
  | { readonly kind: 'NOT_CONFIRMED'; readonly order: Order }
  | { readonly kind: 'NOT_FOUND' };

export interface OrderStore {
  /** `INSERT INTO orders ... ON CONFLICT (id) DO NOTHING`: a repeated commit of one saga is a no-op. */
  insertOrder(order: Order): Promise<void>;
  findOrderById(orderId: string): Promise<Order | null>;
  /** `UPDATE orders SET status='SHIPPED' WHERE id=$1 AND status='CONFIRMED' RETURNING ...`. */
  shipOrder(orderId: string): Promise<ShipOutcome>;

  /** `false` when the client idempotency key is already taken by another saga row. */
  insertOrderOperation(operation: NewOrderOperation): Promise<boolean>;
  findOrderOperation(orderId: string): Promise<OrderOperation | null>;
  findOrderOperationByClientKey(clientIdempotencyKey: string): Promise<OrderOperation | null>;
  updateOrderOperation(orderId: string, update: OrderOperationUpdate): Promise<void>;
  /** Saga rows the recovery worker must still look at (see `isRecoverableState`). */
  listRecoverableOrderOperations(staleStartedCutoff: Date, limit: number): Promise<OrderOperation[]>;

  insertOutboxEntry(entry: NewOutboxEntry): Promise<void>;
  findOutboxEntryByOrderId(orderId: string): Promise<OutboxEntry | null>;
  updateOutboxEntry(id: number, update: OutboxEntryUpdate): Promise<void>;
  listDueOutboxEntries(now: Date, limit: number): Promise<OutboxEntry[]>;
}

export interface OrderUnitOfWork {
  /** One local transaction: the work sees a store bound to it, and a failure rolls everything back. */
  runInTransaction<T>(work: (transaction: OrderStore) => Promise<T>): Promise<T>;
}
