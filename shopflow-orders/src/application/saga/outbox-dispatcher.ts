/**
 * The outbox dispatcher.
 *
 * One responsibility: turn a `PENDING` outbox row into a `DELIVERED` one, or leave it `PENDING` with
 * a bounded exponential backoff and the failure recorded. It is used in two places - inline at step 9
 * of the saga (so the caller learns immediately whether the confirmation went out) and by the
 * background loop (so a failed dispatch is retried until it succeeds).
 *
 * Duplicate dispatches (inline plus background, or two dispatchers) are harmless: the identity of
 * the logical notification is `UNIQUE (type, order_id)` in `shopflow-notifications` and the request
 * carries `Idempotency-Key: ORDER_CONFIRMATION:<orderId>`.
 */

import { outboxBackoffMs } from '../../domain/outbox.js';
import { errorDetail, type ErrorLogger } from '../../logging.js';
import type { NotificationClient } from '../../ports/notification-client.js';
import type { OrderStore } from '../../ports/order-store.js';

export interface OutboxDispatcherDependencies {
  readonly store: OrderStore;
  readonly notifications: NotificationClient;
  readonly backoffBaseMs: number;
  readonly now?: (() => Date) | undefined;
  readonly logError?: ErrorLogger | undefined;
}

export interface DispatchOutcome {
  readonly delivered: boolean;
  readonly error?: string | undefined;
}

export class OutboxDispatcher {
  private readonly store: OrderStore;
  private readonly notifications: NotificationClient;
  private readonly backoffBaseMs: number;
  private readonly now: () => Date;
  private readonly logError: ErrorLogger | undefined;

  constructor(dependencies: OutboxDispatcherDependencies) {
    this.store = dependencies.store;
    this.notifications = dependencies.notifications;
    this.backoffBaseMs = dependencies.backoffBaseMs;
    this.now = dependencies.now ?? (() => new Date());
    this.logError = dependencies.logError;
  }

  /** Dispatches the confirmation of one order, once. Never throws: a failure is recorded state. */
  async dispatchOrderConfirmation(orderId: string, correlationId?: string | undefined): Promise<DispatchOutcome> {
    const entry = await this.store.findOutboxEntryByOrderId(orderId);
    if (entry === null || entry.state === 'DELIVERED') {
      return { delivered: true };
    }

    const result = await this.notifications.dispatchOrderConfirmation({
      orderId: entry.orderId,
      customerEmail: entry.payload.customerEmail,
      correlationId,
    });
    const attempts = entry.attempts + 1;

    if (result.delivered) {
      await this.store.updateOutboxEntry(entry.id, { state: 'DELIVERED', attempts, lastError: null });
      return { delivered: true };
    }

    const nextAttemptAt = new Date(this.now().getTime() + outboxBackoffMs(attempts, this.backoffBaseMs));
    await this.store.updateOutboxEntry(entry.id, {
      state: 'PENDING',
      attempts,
      nextAttemptAt,
      lastError: result.error,
    });
    return { delivered: false, error: result.error };
  }

  /** Dispatches every due `PENDING` row; returns how many rows were processed. */
  async dispatchDue(limit = 25): Promise<number> {
    const due = await this.store.listDueOutboxEntries(this.now(), limit);
    let processed = 0;
    for (const entry of due) {
      try {
        await this.dispatchOrderConfirmation(entry.orderId);
        processed += 1;
      } catch (error) {
        this.logError?.(
          `dispatching the order confirmation of order ${entry.orderId} failed unexpectedly`,
          error,
        );
      }
    }
    return processed;
  }
}

export { errorDetail };
