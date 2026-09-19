import {
  BACKOFF_CAP_MS,
  ORDER_CONFIRMATION,
  computeBackoffDelayMs,
  type NotificationRecord,
  type OrderConfirmationIntent,
} from '../domain/notification.js';
import type { NotificationRepository } from '../ports/notification-repository.js';
import {
  ProviderError,
  type NotificationProvider,
  type ProviderFailureKind,
  type ProviderNotificationRecord,
  type ProviderOrderConfirmationPayload,
} from '../ports/notification-provider.js';
import { silentLogger, type Logger } from '../observability/logger.js';

/**
 * `sent`                   - record created and the provider accepted it (HTTP 201)
 * `delivered-on-retry`     - the record existed as PENDING and this attempt delivered it (200 + replay)
 * `idempotent-replay`      - the record was already DELIVERED, no provider call (200 + replay)
 * `provider-failure`       - provider failed or timed out, the record stays PENDING (502)
 */
export type DispatchOutcomeKind = 'sent' | 'delivered-on-retry' | 'idempotent-replay' | 'provider-failure';

export interface DispatchOutcome {
  readonly kind: DispatchOutcomeKind;
  readonly record: NotificationRecord;
  readonly failure?: { readonly kind: ProviderFailureKind; readonly detail: string };
}

export interface NotificationDeliveryServiceOptions {
  readonly repository: NotificationRepository;
  readonly provider: NotificationProvider;
  readonly backoffBaseMs: number;
  readonly backoffCapMs?: number;
  /** `0` means unlimited attempts. */
  readonly maxAttempts?: number;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

interface AttemptOptions {
  /**
   * The reconcile check (`GET {PROVIDER_URL}/notifications`) runs before every
   * retry, i.e. whenever the record already existed. It closes the ambiguous
   * failure window in which the provider accepted a message but the response was
   * lost: the provider contract has no idempotency key.
   */
  readonly reconcileFirst: boolean;
  readonly successKind: Extract<DispatchOutcomeKind, 'sent' | 'delivered-on-retry'>;
}

/** The exact legacy payload: three fields, forwarded unchanged. */
export function buildProviderPayload(record: NotificationRecord): ProviderOrderConfirmationPayload {
  return {
    type: ORDER_CONFIRMATION,
    orderId: record.orderId,
    customerEmail: record.customerEmail,
  };
}

function toProviderFailure(error: unknown): { kind: ProviderFailureKind; detail: string } {
  if (error instanceof ProviderError) {
    return { kind: error.kind, detail: error.detail };
  }
  if (error instanceof Error) {
    return { kind: 'PROVIDER_ERROR', detail: error.message };
  }
  return { kind: 'PROVIDER_ERROR', detail: String(error) };
}

function matchesNotification(candidate: ProviderNotificationRecord, record: NotificationRecord): boolean {
  const candidateOrderId =
    typeof candidate.orderId === 'string' ? candidate.orderId : typeof candidate.order_id === 'string' ? candidate.order_id : null;
  if (candidateOrderId === null || candidateOrderId !== record.orderId) {
    return false;
  }
  const candidateType = candidate.type;
  return candidateType === undefined || candidateType === null || candidateType === record.type;
}

/**
 * Delivery mechanics of `design/notification-delivery-reliability.md`:
 * persist PENDING (committed) -> synchronous first attempt -> reconciling retries
 * with bounded exponential backoff. One provider call per notification, ever.
 */
export class NotificationDeliveryService {
  private readonly repository: NotificationRepository;
  private readonly provider: NotificationProvider;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly maxAttempts: number;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(options: NotificationDeliveryServiceOptions) {
    this.repository = options.repository;
    this.provider = options.provider;
    this.backoffBaseMs = options.backoffBaseMs;
    this.backoffCapMs = options.backoffCapMs ?? BACKOFF_CAP_MS;
    this.maxAttempts = options.maxAttempts ?? 0;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => new Date());
  }

  /** Synchronous dispatch path used by `POST /notifications/order-confirmations`. */
  async dispatchOrderConfirmation(intent: OrderConfirmationIntent): Promise<DispatchOutcome> {
    const lock = await this.repository.acquireDeliveryLock(intent.type, intent.orderId);
    try {
      const { record, created } = await this.repository.beginDeliveryForIntent(intent);

      if (record.status === 'DELIVERED') {
        return { kind: 'idempotent-replay', record };
      }

      return this.attemptDelivery(record, {
        reconcileFirst: !created,
        successKind: created ? 'sent' : 'delivered-on-retry',
      });
    } finally {
      await lock.release();
    }
  }

  /**
   * Delivery worker body: reconcile + retry every `PENDING` record whose backoff
   * has elapsed. Returns the number of notifications delivered by this pass.
   */
  async processDueDeliveries(limit = 25): Promise<number> {
    const due = await this.repository.selectDuePending(this.now(), limit, this.maxAttempts);
    let delivered = 0;

    for (const candidate of due) {
      const lock = await this.repository.acquireDeliveryLock(candidate.type, candidate.orderId);
      try {
        const current = await this.repository.findById(candidate.id);
        if (!current || current.status !== 'PENDING') {
          continue;
        }
        if (current.nextAttemptAt !== null && current.nextAttemptAt.getTime() > this.now().getTime()) {
          continue;
        }
        if (this.maxAttempts > 0 && current.attempts >= this.maxAttempts) {
          continue;
        }

        const outcome = await this.attemptDelivery(current, { reconcileFirst: true, successKind: 'delivered-on-retry' });
        if (outcome.kind !== 'provider-failure') {
          delivered += 1;
        }
      } finally {
        await lock.release();
      }
    }

    return delivered;
  }

  private async attemptDelivery(record: NotificationRecord, options: AttemptOptions): Promise<DispatchOutcome> {
    if (options.reconcileFirst) {
      let providerRecordId: string | null;
      try {
        providerRecordId = await this.findProviderRecord(record);
      } catch (error) {
        // The inspection endpoint is unreachable: never POST blindly, that could
        // duplicate a message the provider already accepted.
        return this.recordFailure(record, error);
      }

      if (providerRecordId !== null) {
        const delivered = await this.repository.recordDelivered(record.id, {
          outcome: 'RECONCILED',
          providerRecordId,
          detail: `provider already holds ${record.type} for order ${record.orderId} as ${providerRecordId}`,
        });
        this.logger.info('notification reconciled with an existing provider record', {
          notificationId: record.id,
          orderId: record.orderId,
          providerRecordId,
        });
        return { kind: options.successKind, record: delivered };
      }
    }

    try {
      const acceptance = await this.provider.sendOrderConfirmation(buildProviderPayload(record));
      const delivered = await this.repository.recordDelivered(record.id, {
        outcome: 'DELIVERED',
        providerRecordId: acceptance.id,
        detail: `provider accepted the message as ${acceptance.id}`,
      });
      return { kind: options.successKind, record: delivered };
    } catch (error) {
      return this.recordFailure(record, error);
    }
  }

  private async recordFailure(record: NotificationRecord, error: unknown): Promise<DispatchOutcome> {
    const failure = toProviderFailure(error);
    const nextAttemptAt = new Date(
      this.now().getTime() + computeBackoffDelayMs(record.attempts + 1, this.backoffBaseMs, this.backoffCapMs),
    );
    const updated = await this.repository.recordProviderFailure(record.id, {
      outcome: failure.kind,
      detail: failure.detail,
      nextAttemptAt,
    });
    this.logger.warn('notification delivery attempt failed', {
      notificationId: record.id,
      orderId: record.orderId,
      outcome: failure.kind,
      detail: failure.detail,
      nextAttemptAt: nextAttemptAt.toISOString(),
    });
    return { kind: 'provider-failure', record: updated, failure };
  }

  private async findProviderRecord(record: NotificationRecord): Promise<string | null> {
    const providerRecords = await this.provider.listNotifications();
    const match = providerRecords.find((candidate) => matchesNotification(candidate, record));
    if (match === undefined) {
      return null;
    }
    const id = match.id;
    if (typeof id !== 'string' || id === '') {
      throw new ProviderError('PROVIDER_ERROR', 'provider inspection returned a matching record without an id');
    }
    return id;
  }
}
