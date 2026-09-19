/**
 * Notification domain model.
 *
 * This service owns exactly one notification type (`ORDER_CONFIRMATION`) and the
 * delivery state of every notification record. It knows nothing about orders,
 * stock or order statuses: those live in other services and other databases.
 */

/** The only notification type that exists in the shopflow platform. */
export const ORDER_CONFIRMATION = 'ORDER_CONFIRMATION' as const;

export type NotificationType = typeof ORDER_CONFIRMATION;

export type NotificationStatus = 'PENDING' | 'DELIVERED';

/** Outcomes recorded in the attempt history (`notification_attempts.outcome`). */
export type AttemptOutcome = 'DELIVERED' | 'PROVIDER_ERROR' | 'PROVIDER_TIMEOUT' | 'RECONCILED';

export type DeliveredOutcome = Extract<AttemptOutcome, 'DELIVERED' | 'RECONCILED'>;

export type ProviderFailureOutcome = Extract<AttemptOutcome, 'PROVIDER_ERROR' | 'PROVIDER_TIMEOUT'>;

/** Validated inbound intent for `POST /notifications/order-confirmations`. */
export interface OrderConfirmationIntent {
  readonly type: NotificationType;
  readonly orderId: string;
  readonly customerEmail: string;
  /** Locally stored only, never forwarded to the provider. */
  readonly occurredAt: Date | null;
}

/** A notification row as owned by this service. */
export interface NotificationRecord {
  readonly id: string;
  readonly type: NotificationType;
  readonly orderId: string;
  readonly customerEmail: string;
  readonly status: NotificationStatus;
  /** Number of delivery attempts performed for this notification. */
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly providerRecordId: string | null;
  readonly occurredAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Public representation defined by `apis/notifications-service-api.md`.
 * Exactly these fields - no more, no less - are exposed over HTTP.
 */
export interface NotificationView {
  readonly id: string;
  readonly type: NotificationType;
  readonly orderId: string;
  readonly customerEmail: string;
  readonly status: NotificationStatus;
  readonly attempts: number;
  readonly providerRecordId: string | null;
  readonly createdAt: string;
}

/** Backoff cap from `design/notification-delivery-reliability.md`. */
export const BACKOFF_CAP_MS = 30_000;

/** Bounded exponential backoff: base * 2^(attempts-1), capped. */
export function computeBackoffDelayMs(attempts: number, baseMs: number, capMs: number = BACKOFF_CAP_MS): number {
  const safeAttempts = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 1;
  const exponent = Math.min(safeAttempts - 1, 31);
  const delay = baseMs * 2 ** exponent;
  if (!Number.isFinite(delay)) {
    return capMs;
  }
  return Math.min(Math.max(delay, 0), capMs);
}

/** `Idempotency-Key` value required for an order confirmation dispatch. */
export function idempotencyKeyForOrderConfirmation(orderId: string): string {
  return `${ORDER_CONFIRMATION}:${orderId}`;
}

export function toNotificationView(record: NotificationRecord): NotificationView {
  return {
    id: record.id,
    type: record.type,
    orderId: record.orderId,
    customerEmail: record.customerEmail,
    status: record.status,
    attempts: record.attempts,
    providerRecordId: record.providerRecordId,
    createdAt: record.createdAt.toISOString(),
  };
}

export type IntentParseResult = { readonly ok: true; readonly intent: OrderConfirmationIntent } | { readonly ok: false; readonly reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates an inbound order-confirmation intent:
 * `type === 'ORDER_CONFIRMATION'`, a non-empty `orderId` and a `customerEmail`
 * containing `@`. Anything else is an invalid notification (400 INVALID).
 */
export function parseOrderConfirmationIntent(body: unknown): IntentParseResult {
  if (!isPlainObject(body)) {
    return { ok: false, reason: 'body must be a JSON object' };
  }

  const { type, orderId, customerEmail, occurredAt } = body;

  if (type !== ORDER_CONFIRMATION) {
    return { ok: false, reason: `type must be ${ORDER_CONFIRMATION}` };
  }
  if (typeof orderId !== 'string' || orderId.trim().length === 0) {
    return { ok: false, reason: 'orderId is required and must be a non-empty string' };
  }
  if (typeof customerEmail !== 'string' || !customerEmail.includes('@')) {
    return { ok: false, reason: 'customerEmail is required and must contain @' };
  }

  let occurred: Date | null = null;
  if (occurredAt !== undefined && occurredAt !== null) {
    if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) {
      return { ok: false, reason: 'occurredAt must be an ISO-8601 timestamp' };
    }
    occurred = new Date(occurredAt);
  }

  return {
    ok: true,
    intent: {
      type: ORDER_CONFIRMATION,
      orderId,
      customerEmail,
      occurredAt: occurred,
    },
  };
}
