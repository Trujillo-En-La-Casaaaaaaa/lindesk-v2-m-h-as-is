/**
 * `POST /orders` - the order-creation saga of `design/order-creation-saga.md`.
 *
 * The invariant this service implements:
 *
 * > a successful creation produces exactly one `CONFIRMED` order and exactly one stock decrement of
 * > `quantity`; a rejected creation produces no order and no stock change; no stock is ever
 * > decremented without an order or a compensating release.
 *
 * The order id (`crypto.randomUUID()`) is generated before any remote call, it is the primary key of
 * the order and the inventory idempotency key, and it is never regenerated for the same saga row.
 * The saga row is committed before the first remote call, so a crash at any point leaves a durable
 * intent that the recovery worker can continue.
 */

import { randomUUID } from 'node:crypto';
import { errorDetail, type ErrorLogger } from '../../logging.js';
import { ORDER_CONFIRMATION_TYPE, type OrderConfirmationPayload } from '../../domain/outbox.js';
import { parseOrderRequest } from '../../domain/order-request.js';
import { InternalOrderError } from '../../domain/errors.js';
import { toOrderView, totalCentsOf, type Order, type OrderView } from '../../domain/order.js';
import type { OrderOperation } from '../../domain/saga.js';
import type { InventoryClient, StockDecrementOutcome, StockReleaseOutcome } from '../../ports/inventory-client.js';
import type { OrderStore, OrderUnitOfWork } from '../../ports/order-store.js';
import type { OutboxDispatcher } from './outbox-dispatcher.js';

/** `inline` is a customer request (bounded inline retries, immediate dispatch); `worker` is recovery. */
export type SagaMode = 'inline' | 'worker';

export interface OrderCreationDependencies {
  readonly store: OrderStore;
  readonly unitOfWork: OrderUnitOfWork;
  readonly inventory: InventoryClient;
  readonly outbox: OutboxDispatcher;
  /** `INLINE_CALL_ATTEMPTS`: attempts of the inventory decrement inside one customer request. */
  readonly inlineCallAttempts: number;
  readonly inlineRetryBackoffMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly logError?: ErrorLogger | undefined;
}

export interface CreateOrderCommand {
  readonly body: unknown;
  /** The parsed client `Idempotency-Key`; `null` means "absent", i.e. exactly the legacy behaviour. */
  readonly clientIdempotencyKey: string | null;
  readonly correlationId?: string | undefined;
}

export type CreateOrderOutcome =
  | { readonly kind: 'created'; readonly order: OrderView }
  | { readonly kind: 'replayed'; readonly order: OrderView }
  | { readonly kind: 'confirmation-failed'; readonly order: OrderView }
  | { readonly kind: 'insufficient-stock' }
  | { readonly kind: 'product-not-found' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'internal' };

/** What one resolution step of a saga produced. */
export type SagaAdvance =
  | { readonly kind: 'completed'; readonly order: Order; readonly dispatchFailed: boolean }
  | { readonly kind: 'insufficient-stock' }
  | { readonly kind: 'product-not-found' }
  | { readonly kind: 'unavailable'; readonly detail: string }
  | { readonly kind: 'compensated'; readonly detail: string }
  | { readonly kind: 'internal'; readonly detail: string };

export class OrderCreationService {
  private readonly store: OrderStore;
  private readonly unitOfWork: OrderUnitOfWork;
  private readonly inventory: InventoryClient;
  private readonly outbox: OutboxDispatcher;
  private readonly inlineCallAttempts: number;
  private readonly inlineRetryBackoffMs: number;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logError: ErrorLogger | undefined;

  constructor(dependencies: OrderCreationDependencies) {
    this.store = dependencies.store;
    this.unitOfWork = dependencies.unitOfWork;
    this.inventory = dependencies.inventory;
    this.outbox = dependencies.outbox;
    this.inlineCallAttempts = dependencies.inlineCallAttempts;
    this.inlineRetryBackoffMs = dependencies.inlineRetryBackoffMs ?? 100;
    this.now = dependencies.now ?? (() => new Date());
    this.sleep =
      dependencies.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logError = dependencies.logError;
  }

  /**
   * Steps 1-9 for one customer request.
   *
   * Throws `InvalidOrderRequestError` (step 1) for anything the legacy service rejected. Every other
   * outcome is returned as a value so the HTTP adapter maps it to the documented status code.
   */
  async createOrder(command: CreateOrderCommand): Promise<CreateOrderOutcome> {
    // 1. validate input: no saga row, no remote call on failure.
    const input = parseOrderRequest(command.body);

    // 2. a known client key is a replay, never a second intent.
    if (command.clientIdempotencyKey !== null) {
      const existing = await this.store.findOrderOperationByClientKey(command.clientIdempotencyKey);
      if (existing !== null) {
        return this.resumeExistingOperation(existing, command.correlationId);
      }
    }

    // 3. the saga row commits before any remote call.
    const orderId = randomUUID();
    const now = this.now();
    const inserted = await this.store.insertOrderOperation({
      orderId,
      productId: input.productId,
      quantity: input.quantity,
      customerEmail: input.customerEmail,
      clientIdempotencyKey: command.clientIdempotencyKey,
      createdAt: now,
      updatedAt: now,
    });

    if (!inserted) {
      // The client key was taken between the lookup and the insert: that request is the duplicate.
      if (command.clientIdempotencyKey !== null) {
        const existing = await this.store.findOrderOperationByClientKey(command.clientIdempotencyKey);
        if (existing !== null) {
          return this.resumeExistingOperation(existing, command.correlationId);
        }
      }
      throw new InternalOrderError('the order-operation row could not be inserted');
    }

    const operation = await this.store.findOrderOperation(orderId);
    if (operation === null) {
      throw new InternalOrderError('the order-operation row vanished after it was inserted');
    }

    const advance = await this.resolveOrderOperation(operation, 'inline', command.correlationId);
    return toCreateOrderOutcome(advance, false);
  }

  /**
   * Continues one persisted saga exactly one step as far as the current facts allow.
   *
   * Called inline by `createOrder` and by the recovery worker (`mode = 'worker'`), which is why it
   * takes the saga row it must resolve instead of looking it up: the caller has just read it.
   */
  async resolveOrderOperation(
    operation: OrderOperation,
    mode: SagaMode,
    correlationId?: string | undefined,
  ): Promise<SagaAdvance> {
    if (operation.state === 'STARTED' || operation.state === 'UNCERTAIN') {
      const { result, calls } = await this.callDecrementWithRetries(operation, mode, correlationId);
      const attempts = operation.attempts + calls;

      switch (result.kind) {
        case 'DECREMENTED': {
          // 7. the recorded decrement, with the inventory price snapshot.
          await this.store.updateOrderOperation(operation.orderId, {
            state: 'DECREMENTED',
            unitPriceCents: result.unitPriceCents,
            decrementOutcome: 'DECREMENTED',
            attempts,
            lastError: null,
          });
          return this.completeLocalTransaction(
            {
              ...operation,
              state: 'DECREMENTED',
              unitPriceCents: result.unitPriceCents,
              decrementOutcome: 'DECREMENTED',
              attempts,
            },
            correlationId,
          );
        }
        case 'INSUFFICIENT_STOCK': {
          // 6. the legacy rejection: no order row, no stock change, no notification.
          await this.store.updateOrderOperation(operation.orderId, {
            state: 'ABORTED_INSUFFICIENT_STOCK',
            decrementOutcome: 'INSUFFICIENT_STOCK',
            attempts,
            lastError: null,
          });
          return { kind: 'insufficient-stock' };
        }
        case 'PRODUCT_NOT_FOUND': {
          // 5. the legacy rejection: no order row, no stock change.
          await this.store.updateOrderOperation(operation.orderId, {
            state: 'ABORTED_NOT_FOUND',
            decrementOutcome: 'NOT_FOUND',
            attempts,
            lastError: null,
          });
          return { kind: 'product-not-found' };
        }
        case 'ALREADY_RELEASED': {
          // The stock of this order id was given back: no order may be created for it.
          const detail = 'the inventory decrement of this order id was already released';
          await this.store.updateOrderOperation(operation.orderId, {
            state: 'DECREMENTED',
            decrementOutcome: 'RELEASED',
            attempts,
            lastError: detail,
          });
          return { kind: 'compensated', detail };
        }
        case 'UNAVAILABLE': {
          // The outcome is unknown: the recovery worker resolves it by replaying the same key.
          await this.store.updateOrderOperation(operation.orderId, {
            state: 'UNCERTAIN',
            attempts,
            lastError: result.detail,
          });
          return { kind: 'unavailable', detail: result.detail };
        }
      }
    }

    if (operation.state === 'DECREMENTED') {
      if (operation.decrementOutcome === 'RELEASED') {
        return { kind: 'compensated', detail: operation.lastError ?? 'the stock decrement was released' };
      }
      return this.completeLocalTransaction(operation, correlationId);
    }

    if (operation.state === 'COMPLETED') {
      const order = await this.store.findOrderById(operation.orderId);
      if (order === null) {
        return { kind: 'internal', detail: 'the saga is COMPLETED but its order row is missing' };
      }
      return { kind: 'completed', order, dispatchFailed: false };
    }

    if (operation.state === 'ABORTED_NOT_FOUND') {
      return { kind: 'product-not-found' };
    }
    if (operation.state === 'ABORTED_INSUFFICIENT_STOCK') {
      return { kind: 'insufficient-stock' };
    }

    return { kind: 'internal', detail: `unexpected saga state ${String(operation.state)}` };
  }

  /**
   * Step 8: one local transaction writes the order row, the durable outbox row and the saga
   * completion; step 9 dispatches the confirmation (inline) or leaves it to the dispatcher (worker).
   *
   * When the local transaction cannot proceed, the confirmed decrement is compensated with
   * `POST /stock-decrements/:orderId/release`. The release is retried by the recovery worker until it
   * is confirmed, so a saga is never marked aborted without a successful release.
   */
  private async completeLocalTransaction(
    operation: OrderOperation,
    correlationId?: string | undefined,
  ): Promise<SagaAdvance> {
    const orderId = operation.orderId;

    const existing = await this.store.findOrderById(orderId);
    if (existing !== null) {
      const dispatch = await this.outbox.dispatchOrderConfirmation(orderId, correlationId);
      return { kind: 'completed', order: existing, dispatchFailed: !dispatch.delivered };
    }

    if (operation.unitPriceCents === null) {
      const detail = 'the recorded decrement has no price snapshot';
      await this.store.updateOrderOperation(orderId, { lastError: detail });
      return { kind: 'internal', detail };
    }

    const createdAt = this.now();
    const order: Order = {
      id: orderId,
      customerEmail: operation.customerEmail,
      status: 'CONFIRMED',
      productId: operation.productId,
      quantity: operation.quantity,
      totalCents: totalCentsOf(operation.unitPriceCents, operation.quantity),
      createdAt,
    };
    const payload: OrderConfirmationPayload = {
      type: ORDER_CONFIRMATION_TYPE,
      orderId,
      customerEmail: order.customerEmail,
    };

    try {
      await this.unitOfWork.runInTransaction(async (transaction) => {
        await transaction.insertOrder(order);
        await transaction.insertOutboxEntry({
          orderId,
          payload,
          nextAttemptAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        });
        await transaction.updateOrderOperation(orderId, { state: 'COMPLETED', lastError: null });
      });
    } catch (error) {
      const commitDetail = errorDetail(error);
      this.logError?.(`committing the order ${orderId} failed; compensating the stock decrement`, error);

      const release = await this.releaseStock(orderId, correlationId);
      if (release.kind === 'RELEASED' || release.kind === 'NOT_RECORDED' || release.kind === 'NOT_RELEASABLE') {
        const detail = `local commit failed (${commitDetail}); ${describeRelease(release)}`;
        await this.store.updateOrderOperation(orderId, {
          state: 'DECREMENTED',
          decrementOutcome: 'RELEASED',
          lastError: detail,
        });
        return { kind: 'compensated', detail };
      }

      await this.store.updateOrderOperation(orderId, {
        state: 'DECREMENTED',
        decrementOutcome: 'DECREMENTED',
        lastError: `local commit failed (${commitDetail}); the release is still pending (${release.detail})`,
      });
      return { kind: 'internal', detail: commitDetail };
    }

    const dispatch = await this.outbox.dispatchOrderConfirmation(orderId, correlationId);
    if (!dispatch.delivered) {
      // The order is committed and stays CONFIRMED: exactly the legacy behaviour, with a durable
      // intent instead of a lost confirmation.
      return { kind: 'completed', order, dispatchFailed: true };
    }
    return { kind: 'completed', order, dispatchFailed: false };
  }

  private async resumeExistingOperation(
    operation: OrderOperation,
    correlationId?: string | undefined,
  ): Promise<CreateOrderOutcome> {
    const advance = await this.resolveOrderOperation(operation, 'inline', correlationId);
    return toCreateOrderOutcome(advance, true);
  }

  private async callDecrementWithRetries(
    operation: OrderOperation,
    mode: SagaMode,
    correlationId?: string | undefined,
  ): Promise<{ result: StockDecrementOutcome; calls: number }> {
    const maxAttempts = mode === 'inline' ? this.inlineCallAttempts : 1;
    let calls = 0;
    let last: StockDecrementOutcome = { kind: 'UNAVAILABLE', detail: 'the inventory client was never called' };

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      calls = attempt;
      last = await this.decrementOrUnavailable(operation, correlationId);
      if (last.kind !== 'UNAVAILABLE') {
        return { result: last, calls };
      }
      if (attempt < maxAttempts) {
        await this.sleep(this.inlineRetryBackoffMs);
      }
    }

    return { result: last, calls };
  }

  private async decrementOrUnavailable(
    operation: OrderOperation,
    correlationId?: string | undefined,
  ): Promise<StockDecrementOutcome> {
    try {
      return await this.inventory.decrementStock({
        orderId: operation.orderId,
        productId: operation.productId,
        quantity: operation.quantity,
        correlationId,
      });
    } catch (error) {
      return { kind: 'UNAVAILABLE', detail: errorDetail(error) };
    }
  }

  private async releaseStock(orderId: string, correlationId?: string | undefined): Promise<StockReleaseOutcome> {
    try {
      return await this.inventory.releaseStock(orderId, correlationId);
    } catch (error) {
      return { kind: 'UNAVAILABLE', detail: errorDetail(error) };
    }
  }
}

function describeRelease(release: StockReleaseOutcome): string {
  switch (release.kind) {
    case 'RELEASED':
      return 'the stock decrement was released';
    case 'NOT_RECORDED':
      return `the inventory service records no decrement for this order (${release.detail}), so no stock is held`;
    case 'NOT_RELEASABLE':
      return `the inventory service holds no releasable decrement for this order (${release.detail})`;
    case 'UNAVAILABLE':
      return `the release could not be confirmed (${release.detail})`;
  }
}

function toCreateOrderOutcome(advance: SagaAdvance, replay: boolean): CreateOrderOutcome {
  switch (advance.kind) {
    case 'completed':
      if (replay) {
        return { kind: 'replayed', order: toOrderView(advance.order) };
      }
      return advance.dispatchFailed
        ? { kind: 'confirmation-failed', order: toOrderView(advance.order) }
        : { kind: 'created', order: toOrderView(advance.order) };
    case 'insufficient-stock':
      return { kind: 'insufficient-stock' };
    case 'product-not-found':
      return { kind: 'product-not-found' };
    case 'unavailable':
      return { kind: 'unavailable' };
    case 'compensated':
    case 'internal':
      return { kind: 'internal' };
  }
}
