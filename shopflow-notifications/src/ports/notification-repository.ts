import type { AttemptOutcome, NotificationRecord, OrderConfirmationIntent, ProviderFailureOutcome } from '../domain/notification.js';

/** Result of persisting the `PENDING` record before the provider is called. */
export interface BeginDeliveryResult {
  readonly record: NotificationRecord;
  /** `true` when this call created the record, `false` when it already existed. */
  readonly created: boolean;
}

export interface DeliverySuccess {
  readonly outcome: Extract<AttemptOutcome, 'DELIVERED' | 'RECONCILED'>;
  readonly providerRecordId: string;
  readonly detail: string;
}

export interface DeliveryFailure {
  readonly outcome: ProviderFailureOutcome;
  readonly detail: string;
  /** Bounded exponential backoff schedule for the next attempt. */
  readonly nextAttemptAt: Date;
}

/**
 * Serializes every delivery attempt of one logical notification (one
 * `(type, order_id)` datum) across requests and worker ticks, so that at most one
 * provider call for a given notification can ever be in flight.
 */
export interface NotificationDeliveryLock {
  release(): Promise<void>;
}

/**
 * Persistence port for `notifications-db`. Implemented by the PostgreSQL adapter;
 * unit tests use a behaviour-identical in-memory double.
 */
export interface NotificationRepository {
  /**
   * One local transaction: insert the record for `(type, order_id)` as `PENDING`
   * (an existing row keeps its id, attempts and status) and return it. The record
   * is committed *before* the provider is called, so a crash cannot lose the
   * notification and the unique `(type, order_id)` constraint turns a repeated
   * dispatch into a no-op that follows the existing record's state.
   *
   * The attempt row of this attempt is appended by `recordDelivered` /
   * `recordProviderFailure`, in one transaction with the outcome, because
   * `notification_attempts.outcome` is NOT NULL with a closed value set in the
   * authoritative schema: the outcome does not exist before the provider replied.
   */
  beginDeliveryForIntent(intent: OrderConfirmationIntent): Promise<BeginDeliveryResult>;

  /** Acquires the per-notification delivery lock. */
  acquireDeliveryLock(type: string, orderId: string): Promise<NotificationDeliveryLock>;

  findById(notificationId: string): Promise<NotificationRecord | null>;

  /**
   * One local transaction: the provider accepted the message - store
   * `provider_record_id`, set `DELIVERED`, increment `attempts` and append the
   * attempt row. A record that is already `DELIVERED` is returned untouched.
   */
  recordDelivered(notificationId: string, success: DeliverySuccess): Promise<NotificationRecord>;

  /**
   * One local transaction: the provider failed - the record stays `PENDING`,
   * `attempts` is incremented, `next_attempt_at` is scheduled and the attempt row
   * is appended.
   */
  recordProviderFailure(notificationId: string, failure: DeliveryFailure): Promise<NotificationRecord>;

  /** `PENDING` records whose `next_attempt_at` has passed (oldest first). */
  selectDuePending(now: Date, limit: number, maxAttempts: number): Promise<NotificationRecord[]>;

  /** All records, oldest first. */
  list(): Promise<NotificationRecord[]>;

  close(): Promise<void>;
}
