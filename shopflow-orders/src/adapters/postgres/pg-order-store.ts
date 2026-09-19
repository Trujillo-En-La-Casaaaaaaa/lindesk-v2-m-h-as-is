/**
 * PostgreSQL adapter of `OrderStore`: the three tables this repository owns
 * (`orders`, `order_operations`, `notification_outbox`) and nothing else.
 *
 * No statement of this file touches another service's data; `orders.product_id` is deliberately not
 * a foreign key (the product row lives in the inventory service's own database) and the integrity of
 * that reference is the order-creation saga's job.
 */

import type { Order, OrderStatus } from '../../domain/order.js';
import type { NewOutboxEntry, OrderConfirmationPayload, OutboxEntry, OutboxEntryUpdate } from '../../domain/outbox.js';
import type {
  DecrementOutcome,
  NewOrderOperation,
  OrderOperation,
  OrderOperationUpdate,
  SagaState,
} from '../../domain/saga.js';
import type { OrderStore, ShipOutcome } from '../../ports/order-store.js';
import type { Queryable } from './queryable.js';

const ORDER_COLUMNS = 'id, customer_email, status, product_id, quantity, total_cents, created_at';
const OPERATION_COLUMNS =
  'order_id, state, product_id, quantity, customer_email, client_idempotency_key, unit_price_cents, ' +
  'decrement_outcome, attempts, last_error, created_at, updated_at';
const OUTBOX_COLUMNS =
  'id, order_id, type, payload, state, attempts, next_attempt_at, last_error, created_at, updated_at';

interface OrderRow {
  id: string;
  customer_email: string;
  status: string;
  product_id: string;
  quantity: number;
  total_cents: number;
  created_at: Date;
}

interface OperationRow {
  order_id: string;
  state: string;
  product_id: string;
  quantity: number;
  customer_email: string;
  client_idempotency_key: string | null;
  unit_price_cents: number | null;
  decrement_outcome: string | null;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

interface OutboxRow {
  id: string;
  order_id: string;
  type: string;
  payload: unknown;
  state: string;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PgOrderStoreOptions {
  readonly now?: (() => Date) | undefined;
}

export class PgOrderStore implements OrderStore {
  private readonly now: () => Date;

  constructor(
    private readonly queryable: Queryable,
    options: PgOrderStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async insertOrder(order: Order): Promise<void> {
    await this.queryable.query(
      `INSERT INTO orders (id, customer_email, status, product_id, quantity, total_cents, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        order.id,
        order.customerEmail,
        order.status,
        order.productId,
        order.quantity,
        order.totalCents,
        order.createdAt,
      ],
    );
  }

  async findOrderById(orderId: string): Promise<Order | null> {
    const result = await this.queryable.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`,
      [orderId],
    );
    return firstRow(result.rows, toOrder);
  }

  async shipOrder(orderId: string): Promise<ShipOutcome> {
    // One conditional statement: concurrent ship calls of the same order cannot both succeed.
    const updated = await this.queryable.query<OrderRow>(
      `UPDATE orders SET status = 'SHIPPED' WHERE id = $1 AND status = 'CONFIRMED'
       RETURNING ${ORDER_COLUMNS}`,
      [orderId],
    );
    const shipped = updated.rows[0];
    if (shipped !== undefined) {
      return { kind: 'SHIPPED', order: toOrder(shipped) };
    }

    const existing = await this.queryable.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`,
      [orderId],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      return { kind: 'NOT_FOUND' };
    }
    return { kind: 'NOT_CONFIRMED', order: toOrder(row) };
  }

  async insertOrderOperation(operation: NewOrderOperation): Promise<boolean> {
    const result = await this.queryable.query(
      `INSERT INTO order_operations
         (order_id, state, product_id, quantity, customer_email, client_idempotency_key, attempts, created_at, updated_at)
       VALUES ($1, 'STARTED', $2, $3, $4, $5, 0, $6, $7)
       ON CONFLICT (client_idempotency_key) DO NOTHING
       RETURNING order_id`,
      [
        operation.orderId,
        operation.productId,
        operation.quantity,
        operation.customerEmail,
        operation.clientIdempotencyKey,
        operation.createdAt,
        operation.updatedAt,
      ],
    );
    return result.rows.length === 1;
  }

  async findOrderOperation(orderId: string): Promise<OrderOperation | null> {
    const result = await this.queryable.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM order_operations WHERE order_id = $1`,
      [orderId],
    );
    return firstRow(result.rows, toOrderOperation);
  }

  async findOrderOperationByClientKey(clientIdempotencyKey: string): Promise<OrderOperation | null> {
    const result = await this.queryable.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM order_operations WHERE client_idempotency_key = $1`,
      [clientIdempotencyKey],
    );
    return firstRow(result.rows, toOrderOperation);
  }

  async updateOrderOperation(orderId: string, update: OrderOperationUpdate): Promise<void> {
    const values: unknown[] = [orderId];
    const assignments: string[] = [];
    const set = (column: string, value: unknown): void => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };

    if (update.state !== undefined) {
      set('state', update.state);
    }
    if (update.unitPriceCents !== undefined) {
      set('unit_price_cents', update.unitPriceCents);
    }
    if (update.decrementOutcome !== undefined) {
      set('decrement_outcome', update.decrementOutcome);
    }
    if (update.attempts !== undefined) {
      set('attempts', update.attempts);
    }
    if (update.lastError !== undefined) {
      set('last_error', update.lastError);
    }
    set('updated_at', this.now());

    await this.queryable.query(
      `UPDATE order_operations SET ${assignments.join(', ')} WHERE order_id = $1`,
      values,
    );
  }

  async listRecoverableOrderOperations(staleStartedCutoff: Date, limit: number): Promise<OrderOperation[]> {
    const result = await this.queryable.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM order_operations
        WHERE (state = 'STARTED' AND updated_at < $1)
           OR (state IN ('DECREMENTED', 'UNCERTAIN') AND (decrement_outcome IS DISTINCT FROM 'RELEASED'))
        ORDER BY updated_at ASC, order_id ASC
        LIMIT $2`,
      [staleStartedCutoff, limit],
    );
    return result.rows.map(toOrderOperation);
  }

  async insertOutboxEntry(entry: NewOutboxEntry): Promise<void> {
    await this.queryable.query(
      `INSERT INTO notification_outbox
         (order_id, type, payload, state, attempts, next_attempt_at, created_at, updated_at)
       VALUES ($1, 'ORDER_CONFIRMATION', $2::jsonb, 'PENDING', 0, $3, $4, $5)
       ON CONFLICT (type, order_id) DO NOTHING`,
      [
        entry.orderId,
        JSON.stringify(entry.payload),
        entry.nextAttemptAt,
        entry.createdAt,
        entry.updatedAt,
      ],
    );
  }

  async findOutboxEntryByOrderId(orderId: string): Promise<OutboxEntry | null> {
    const result = await this.queryable.query<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM notification_outbox
        WHERE type = 'ORDER_CONFIRMATION' AND order_id = $1`,
      [orderId],
    );
    return firstRow(result.rows, toOutboxEntry);
  }

  async updateOutboxEntry(id: number, update: OutboxEntryUpdate): Promise<void> {
    const values: unknown[] = [id];
    const assignments: string[] = [];
    const set = (column: string, value: unknown): void => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };

    if (update.state !== undefined) {
      set('state', update.state);
    }
    if (update.attempts !== undefined) {
      set('attempts', update.attempts);
    }
    if (update.nextAttemptAt !== undefined) {
      set('next_attempt_at', update.nextAttemptAt);
    }
    if (update.lastError !== undefined) {
      set('last_error', update.lastError);
    }
    set('updated_at', this.now());

    await this.queryable.query(
      `UPDATE notification_outbox SET ${assignments.join(', ')} WHERE id = $1`,
      values,
    );
  }

  async listDueOutboxEntries(now: Date, limit: number): Promise<OutboxEntry[]> {
    const result = await this.queryable.query<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM notification_outbox
        WHERE state = 'PENDING' AND next_attempt_at <= $1
        ORDER BY id ASC
        LIMIT $2`,
      [now, limit],
    );
    return result.rows.map(toOutboxEntry);
  }
}

function firstRow<Row, Value>(rows: Row[], convert: (row: Row) => Value): Value | null {
  const row = rows[0];
  return row === undefined ? null : convert(row);
}

function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    customerEmail: row.customer_email,
    status: row.status as OrderStatus,
    productId: row.product_id,
    quantity: row.quantity,
    totalCents: row.total_cents,
    createdAt: row.created_at,
  };
}

function toOrderOperation(row: OperationRow): OrderOperation {
  return {
    orderId: row.order_id,
    state: row.state as SagaState,
    productId: row.product_id,
    quantity: row.quantity,
    customerEmail: row.customer_email,
    clientIdempotencyKey: row.client_idempotency_key,
    unitPriceCents: row.unit_price_cents,
    decrementOutcome: row.decrement_outcome as DecrementOutcome | null,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toOutboxEntry(row: OutboxRow): OutboxEntry {
  return {
    id: Number(row.id),
    orderId: row.order_id,
    type: 'ORDER_CONFIRMATION',
    payload: row.payload as OrderConfirmationPayload,
    state: row.state === 'DELIVERED' ? 'DELIVERED' : 'PENDING',
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
