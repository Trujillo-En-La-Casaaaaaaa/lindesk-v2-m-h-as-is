/**
 * Recording doubles of the two frozen contracts, used by the unit tests (no network).
 *
 * They record every call - the tests assert exactly how often the inventory decrement and the
 * release were called, and which idempotency keys were used - and their answers are scripted per
 * call, so the `UNCERTAIN`, compensation and outbox-failure branches are reachable without a
 * running service.
 */

import type {
  InventoryClient,
  StockDecrementOutcome,
  StockDecrementRequest,
  StockReleaseOutcome,
} from '../ports/inventory-client.js';
import type {
  NotificationClient,
  NotificationDispatchResult,
  OrderConfirmationIntent,
} from '../ports/notification-client.js';

export interface RecordedReleaseCall {
  readonly orderId: string;
  readonly correlationId?: string | undefined;
}

export type DecrementHandler = (
  request: StockDecrementRequest,
  call: number,
) => StockDecrementOutcome | Promise<StockDecrementOutcome>;

export type ReleaseHandler = (
  call: RecordedReleaseCall,
  attempt: number,
) => StockReleaseOutcome | Promise<StockReleaseOutcome>;

export interface RecordedInventoryOptions {
  readonly decrement?: DecrementHandler | undefined;
  readonly release?: ReleaseHandler | undefined;
}

/** The default answer: a successful decrement of a product priced at 1200 cents with 7 left. */
export function decreaseWith(unitPriceCents = 1200, remainingStock: number | null = 7): DecrementHandler {
  return (request) => ({
    kind: 'DECREMENTED',
    unitPriceCents,
    totalCents: unitPriceCents * request.quantity,
    remainingStock,
    replayed: false,
  });
}

export class RecordedInventoryClient implements InventoryClient {
  readonly decrementCalls: StockDecrementRequest[] = [];
  readonly releaseCalls: RecordedReleaseCall[] = [];

  private decrementHandler: DecrementHandler;
  private releaseHandler: ReleaseHandler;

  constructor(options: RecordedInventoryOptions = {}) {
    this.decrementHandler = options.decrement ?? decreaseWith();
    this.releaseHandler = options.release ?? (() => ({ kind: 'RELEASED', releasedQuantity: null }));
  }

  setDecrementHandler(handler: DecrementHandler): void {
    this.decrementHandler = handler;
  }

  setReleaseHandler(handler: ReleaseHandler): void {
    this.releaseHandler = handler;
  }

  async decrementStock(request: StockDecrementRequest): Promise<StockDecrementOutcome> {
    this.decrementCalls.push(request);
    return this.decrementHandler(request, this.decrementCalls.length);
  }

  async releaseStock(orderId: string, correlationId?: string | undefined): Promise<StockReleaseOutcome> {
    const call: RecordedReleaseCall = { orderId, correlationId };
    this.releaseCalls.push(call);
    return this.releaseHandler(call, this.releaseCalls.length);
  }
}

export type NotificationHandler = (
  intent: OrderConfirmationIntent,
  call: number,
) => NotificationDispatchResult | Promise<NotificationDispatchResult>;

/** Records the dispatch attempts; delivered by default. */
export class RecordedNotificationClient implements NotificationClient {
  readonly dispatches: OrderConfirmationIntent[] = [];

  private handler: NotificationHandler;

  constructor(handler: NotificationHandler = () => ({ delivered: true })) {
    this.handler = handler;
  }

  setHandler(handler: NotificationHandler): void {
    this.handler = handler;
  }

  async dispatchOrderConfirmation(intent: OrderConfirmationIntent): Promise<NotificationDispatchResult> {
    this.dispatches.push(intent);
    return this.handler(intent, this.dispatches.length);
  }
}
