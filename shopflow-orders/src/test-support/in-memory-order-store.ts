/**
 * In-memory implementation of the persistence port, used by the unit tests only.
 *
 * It mirrors the semantics of the PostgreSQL adapter that the production code uses: `ON CONFLICT
 * DO NOTHING` for the order and outbox inserts, the unique client idempotency key, the single
 * conditional statement of the ship transition - and, in `InMemoryOrderUnitOfWork`, a real
 * all-or-nothing local transaction with an injectable commit failure (the ORD-U8 scenario). No
 * production path can reach this file: the composition root always builds the PostgreSQL adapters.
 */

import type { Order } from '../domain/order.js';
import type { NewOutboxEntry, OutboxEntry, OutboxEntryUpdate } from '../domain/outbox.js';
import type { NewOrderOperation, OrderOperation, OrderOperationUpdate } from '../domain/saga.js';
import type { OrderStore, OrderUnitOfWork, ShipOutcome } from '../ports/order-store.js';

interface Snapshot {
  readonly orders: Map<string, Order>;
  readonly operations: Map<string, OrderOperation>;
  readonly outbox: Map<number, OutboxEntry>;
  readonly nextOutboxId: number;
}

export class InMemoryOrderStore implements OrderStore {
  readonly orders = new Map<string, Order>();
  readonly operations = new Map<string, OrderOperation>();
  readonly outbox = new Map<number, OutboxEntry>();

  /** Injected failures: `insertOrder` is how a local transaction fails in the ORD-U8 scenario. */
  failNextOrderInsert: Error | null = null;
  failNextOutboxInsert: Error | null = null;

  private nextOutboxId = 1;

  async insertOrder(order: Order): Promise<void> {
    if (this.failNextOrderInsert !== null) {
      const failure = this.failNextOrderInsert;
      this.failNextOrderInsert = null;
      throw failure;
    }
    if (!this.orders.has(order.id)) {
      this.orders.set(order.id, order);
    }
  }

  async findOrderById(orderId: string): Promise<Order | null> {
    return this.orders.get(orderId) ?? null;
  }

  async shipOrder(orderId: string): Promise<ShipOutcome> {
    const order = this.orders.get(orderId);
    if (order === undefined) {
      return { kind: 'NOT_FOUND' };
    }
    if (order.status !== 'CONFIRMED') {
      return { kind: 'NOT_CONFIRMED', order };
    }
    const shipped: Order = { ...order, status: 'SHIPPED' };
    this.orders.set(orderId, shipped);
    return { kind: 'SHIPPED', order: shipped };
  }

  async insertOrderOperation(operation: NewOrderOperation): Promise<boolean> {
    if (
      operation.clientIdempotencyKey !== null &&
      [...this.operations.values()].some(
        (existing) => existing.clientIdempotencyKey === operation.clientIdempotencyKey,
      )
    ) {
      return false;
    }
    this.operations.set(operation.orderId, {
      orderId: operation.orderId,
      state: 'STARTED',
      productId: operation.productId,
      quantity: operation.quantity,
      customerEmail: operation.customerEmail,
      clientIdempotencyKey: operation.clientIdempotencyKey,
      unitPriceCents: null,
      decrementOutcome: null,
      attempts: 0,
      lastError: null,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    });
    return true;
  }

  async findOrderOperation(orderId: string): Promise<OrderOperation | null> {
    return this.operations.get(orderId) ?? null;
  }

  async findOrderOperationByClientKey(clientIdempotencyKey: string): Promise<OrderOperation | null> {
    return (
      [...this.operations.values()].find(
        (operation) => operation.clientIdempotencyKey === clientIdempotencyKey,
      ) ?? null
    );
  }

  async updateOrderOperation(orderId: string, update: OrderOperationUpdate): Promise<void> {
    const current = this.operations.get(orderId);
    if (current === undefined) {
      throw new Error(`no order operation ${orderId} to update`);
    }
    this.operations.set(orderId, {
      ...current,
      ...(update.state === undefined ? {} : { state: update.state }),
      ...(update.unitPriceCents === undefined ? {} : { unitPriceCents: update.unitPriceCents }),
      ...(update.decrementOutcome === undefined ? {} : { decrementOutcome: update.decrementOutcome }),
      ...(update.attempts === undefined ? {} : { attempts: update.attempts }),
      ...(update.lastError === undefined ? {} : { lastError: update.lastError }),
      updatedAt: new Date(),
    });
  }

  async listRecoverableOrderOperations(staleStartedCutoff: Date, limit: number): Promise<OrderOperation[]> {
    return [...this.operations.values()]
      .filter(
        (operation) =>
          (operation.state === 'STARTED' && operation.updatedAt.getTime() < staleStartedCutoff.getTime()) ||
          ((operation.state === 'DECREMENTED' || operation.state === 'UNCERTAIN') &&
            operation.decrementOutcome !== 'RELEASED'),
      )
      .sort(
        (left, right) =>
          left.updatedAt.getTime() - right.updatedAt.getTime() || left.orderId.localeCompare(right.orderId),
      )
      .slice(0, limit);
  }

  async insertOutboxEntry(entry: NewOutboxEntry): Promise<void> {
    if (this.failNextOutboxInsert !== null) {
      const failure = this.failNextOutboxInsert;
      this.failNextOutboxInsert = null;
      throw failure;
    }
    const existing = await this.findOutboxEntryByOrderId(entry.orderId);
    if (existing !== null) {
      return;
    }
    const id = this.nextOutboxId;
    this.nextOutboxId += 1;
    this.outbox.set(id, {
      id,
      orderId: entry.orderId,
      type: 'ORDER_CONFIRMATION',
      payload: entry.payload,
      state: 'PENDING',
      attempts: 0,
      nextAttemptAt: entry.nextAttemptAt,
      lastError: null,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    });
  }

  async findOutboxEntryByOrderId(orderId: string): Promise<OutboxEntry | null> {
    return [...this.outbox.values()].find((entry) => entry.orderId === orderId) ?? null;
  }

  async updateOutboxEntry(id: number, update: OutboxEntryUpdate): Promise<void> {
    const current = this.outbox.get(id);
    if (current === undefined) {
      throw new Error(`no outbox entry ${id} to update`);
    }
    this.outbox.set(id, {
      ...current,
      ...(update.state === undefined ? {} : { state: update.state }),
      ...(update.attempts === undefined ? {} : { attempts: update.attempts }),
      ...(update.nextAttemptAt === undefined ? {} : { nextAttemptAt: update.nextAttemptAt }),
      ...(update.lastError === undefined ? {} : { lastError: update.lastError }),
      updatedAt: new Date(),
    });
  }

  async listDueOutboxEntries(now: Date, limit: number): Promise<OutboxEntry[]> {
    return [...this.outbox.values()]
      .filter((entry) => entry.state === 'PENDING' && entry.nextAttemptAt.getTime() <= now.getTime())
      .sort((left, right) => left.id - right.id)
      .slice(0, limit);
  }

  snapshot(): Snapshot {
    return {
      orders: structuredClone(this.orders),
      operations: structuredClone(this.operations),
      outbox: structuredClone(this.outbox),
      nextOutboxId: this.nextOutboxId,
    };
  }

  restore(snapshot: Snapshot): void {
    this.orders.clear();
    for (const [key, value] of snapshot.orders) {
      this.orders.set(key, value);
    }
    this.operations.clear();
    for (const [key, value] of snapshot.operations) {
      this.operations.set(key, value);
    }
    this.outbox.clear();
    for (const [key, value] of snapshot.outbox) {
      this.outbox.set(key, value);
    }
    this.nextOutboxId = snapshot.nextOutboxId;
  }
}

export class InMemoryOrderUnitOfWork implements OrderUnitOfWork {
  private pendingCommitFailure: Error | null = null;

  constructor(private readonly store: InMemoryOrderStore) {}

  /** The next local transaction rolls back as if its `COMMIT` had failed. */
  failNextCommitWith(error: Error): void {
    this.pendingCommitFailure = error;
  }

  async runInTransaction<T>(work: (transaction: OrderStore) => Promise<T>): Promise<T> {
    const snapshot = this.store.snapshot();
    try {
      const result = await work(this.store);
      if (this.pendingCommitFailure !== null) {
        const failure = this.pendingCommitFailure;
        this.pendingCommitFailure = null;
        throw failure;
      }
      return result;
    } catch (error) {
      this.store.restore(snapshot);
      throw error;
    }
  }
}
