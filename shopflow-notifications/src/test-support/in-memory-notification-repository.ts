import type {
  BeginDeliveryResult,
  DeliveryFailure,
  DeliverySuccess,
  NotificationDeliveryLock,
  NotificationRepository,
} from '../ports/notification-repository.js';
import type { AttemptOutcome, NotificationRecord, OrderConfirmationIntent } from '../domain/notification.js';

export interface AttemptRecord {
  readonly notificationId: string;
  readonly attempt: number;
  readonly outcome: AttemptOutcome;
  readonly detail: string;
}

/**
 * Behaviour-identical in-memory double of the PostgreSQL repository, used only by
 * unit tests that must run without a database. It is not a fallback of the
 * production composition: `createNotificationService` uses `pg` unless a test
 * injects this double explicitly.
 */
export class InMemoryNotificationRepository implements NotificationRepository {
  readonly notifications = new Map<string, NotificationRecord>();
  readonly attempts: AttemptRecord[] = [];
  /** Number of read operations, used to prove `/health` never touches storage. */
  readCount = 0;
  /** Set to make every write fail (500 path). */
  failWrites: Error | null = null;
  /** Set to make every read fail (500 path). */
  failReads: Error | null = null;

  private sequence = 0;
  private readonly lockTails = new Map<string, Promise<void>>();

  async beginDeliveryForIntent(intent: OrderConfirmationIntent): Promise<BeginDeliveryResult> {
    this.readCount += 1;
    if (this.failWrites !== null) {
      throw this.failWrites;
    }
    const existing = this.findByTypeAndOrder(intent.type, intent.orderId);
    if (existing) {
      return { record: existing, created: false };
    }
    this.sequence += 1;
    const now = new Date();
    const record: NotificationRecord = {
      id: `ntf-${String(this.sequence).padStart(4, '0')}`,
      type: intent.type,
      orderId: intent.orderId,
      customerEmail: intent.customerEmail,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: null,
      providerRecordId: null,
      occurredAt: intent.occurredAt,
      createdAt: now,
      updatedAt: now,
    };
    this.notifications.set(record.id, record);
    return { record, created: true };
  }

  async acquireDeliveryLock(type: string, orderId: string): Promise<NotificationDeliveryLock> {
    return this.acquireLock(`${type}:${orderId}`);
  }

  async findById(notificationId: string): Promise<NotificationRecord | null> {
    this.readCount += 1;
    if (this.failReads !== null) {
      throw this.failReads;
    }
    return this.notifications.get(notificationId) ?? null;
  }

  async recordDelivered(notificationId: string, success: DeliverySuccess): Promise<NotificationRecord> {
    if (this.failWrites !== null) {
      throw this.failWrites;
    }
    const current = this.require(notificationId);
    if (current.status === 'DELIVERED') {
      return current;
    }
    const updated: NotificationRecord = {
      ...current,
      status: 'DELIVERED',
      providerRecordId: success.providerRecordId,
      attempts: current.attempts + 1,
      nextAttemptAt: null,
      updatedAt: new Date(),
    };
    this.notifications.set(updated.id, updated);
    this.attempts.push({
      notificationId: updated.id,
      attempt: updated.attempts,
      outcome: success.outcome,
      detail: success.detail,
    });
    return updated;
  }

  async recordProviderFailure(notificationId: string, failure: DeliveryFailure): Promise<NotificationRecord> {
    if (this.failWrites !== null) {
      throw this.failWrites;
    }
    const current = this.require(notificationId);
    if (current.status === 'DELIVERED') {
      return current;
    }
    const updated: NotificationRecord = {
      ...current,
      attempts: current.attempts + 1,
      nextAttemptAt: failure.nextAttemptAt,
      updatedAt: new Date(),
    };
    this.notifications.set(updated.id, updated);
    this.attempts.push({
      notificationId: updated.id,
      attempt: updated.attempts,
      outcome: failure.outcome,
      detail: failure.detail,
    });
    return updated;
  }

  async selectDuePending(now: Date, limit: number, maxAttempts: number): Promise<NotificationRecord[]> {
    this.readCount += 1;
    if (this.failReads !== null) {
      throw this.failReads;
    }
    return this.sorted().filter((record) => {
      if (record.status !== 'PENDING') {
        return false;
      }
      if (record.nextAttemptAt !== null && record.nextAttemptAt.getTime() > now.getTime()) {
        return false;
      }
      if (maxAttempts > 0 && record.attempts >= maxAttempts) {
        return false;
      }
      return true;
    }).slice(0, limit);
  }

  async list(): Promise<NotificationRecord[]> {
    this.readCount += 1;
    if (this.failReads !== null) {
      throw this.failReads;
    }
    return this.sorted();
  }

  async close(): Promise<void> {
    // nothing to release
  }

  attemptsFor(notificationId: string): AttemptRecord[] {
    return this.attempts.filter((attempt) => attempt.notificationId === notificationId);
  }

  findByTypeAndOrder(type: string, orderId: string): NotificationRecord | null {
    for (const record of this.notifications.values()) {
      if (record.type === type && record.orderId === orderId) {
        return record;
      }
    }
    return null;
  }

  reset(): void {
    this.notifications.clear();
    this.attempts.length = 0;
    this.sequence = 0;
    this.readCount = 0;
    this.failWrites = null;
    this.failReads = null;
    this.lockTails.clear();
  }

  private sorted(): NotificationRecord[] {
    return [...this.notifications.values()].sort((left, right) => {
      const delta = left.createdAt.getTime() - right.createdAt.getTime();
      return delta !== 0 ? delta : left.id.localeCompare(right.id);
    });
  }

  private require(notificationId: string): NotificationRecord {
    const record = this.notifications.get(notificationId);
    if (!record) {
      throw new Error(`notification ${notificationId} does not exist`);
    }
    return record;
  }

  private async acquireLock(key: string): Promise<NotificationDeliveryLock> {
    const previous = this.lockTails.get(key) ?? Promise.resolve();
    let releaseCurrent: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.then(() => current);
    this.lockTails.set(key, tail);
    await previous;

    let released = false;
    return {
      release: async (): Promise<void> => {
        if (released) {
          return;
        }
        released = true;
        releaseCurrent();
        if (this.lockTails.get(key) === tail) {
          this.lockTails.delete(key);
        }
      },
    };
  }
}
