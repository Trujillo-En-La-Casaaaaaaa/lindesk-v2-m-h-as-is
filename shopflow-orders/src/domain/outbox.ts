/**
 * The durable notification intent (`notification_outbox`).
 *
 * The outbox row is written in the same local transaction as the order row, so a committed order can
 * never lose its confirmation: a failed dispatch leaves the row `PENDING` and the dispatcher retries
 * it. Delivery to `shopflow-notifications` is logically idempotent - the service enforces
 * `UNIQUE (type, order_id)` and this service sends `Idempotency-Key: ORDER_CONFIRMATION:<orderId>`.
 */

import type { OutboxState } from './saga.js';

export type { OutboxState } from './saga.js';

export const ORDER_CONFIRMATION_TYPE = 'ORDER_CONFIRMATION';

/** The provider-visible payload; identical to the legacy confirmation message. */
export interface OrderConfirmationPayload {
  readonly type: typeof ORDER_CONFIRMATION_TYPE;
  readonly orderId: string;
  readonly customerEmail: string;
}

/** One row of `notification_outbox`. */
export interface OutboxEntry {
  readonly id: number;
  readonly orderId: string;
  readonly type: typeof ORDER_CONFIRMATION_TYPE;
  readonly payload: OrderConfirmationPayload;
  readonly state: OutboxState;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewOutboxEntry {
  readonly orderId: string;
  readonly payload: OrderConfirmationPayload;
  readonly nextAttemptAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OutboxEntryUpdate {
  readonly state?: OutboxState;
  readonly attempts?: number;
  readonly nextAttemptAt?: Date;
  readonly lastError?: string | null;
}

/** Bounded exponential backoff: `base * 2^(attempts-1)`, capped at 30 s. */
export const OUTBOX_MAX_BACKOFF_MS = 30_000;

export function outboxBackoffMs(attempts: number, baseMs: number): number {
  const exponent = Math.max(attempts, 1) - 1;
  const growth = baseMs * 2 ** Math.min(exponent, 30);
  return Math.min(Math.max(growth, baseMs), OUTBOX_MAX_BACKOFF_MS);
}
