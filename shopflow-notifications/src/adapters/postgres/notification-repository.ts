import { Pool } from 'pg';
import type { PoolClient } from 'pg';

import type {
  DeliveryFailure,
  DeliverySuccess,
  NotificationDeliveryLock,
  NotificationRepository,
} from '../../ports/notification-repository.js';
import type { BeginDeliveryResult } from '../../ports/notification-repository.js';
import type { NotificationRecord, OrderConfirmationIntent } from '../../domain/notification.js';
import { silentLogger, type Logger } from '../../observability/logger.js';

export interface PostgresNotificationRepositoryOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  readonly logger?: Logger;
}

type NotificationRow = {
  id: string;
  type: 'ORDER_CONFIRMATION';
  order_id: string;
  customer_email: string;
  status: 'PENDING' | 'DELIVERED';
  attempts: number;
  next_attempt_at: Date | null;
  provider_record_id: string | null;
  occurred_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type SchemaProbeRow = {
  notifications: string | null;
  notification_attempts: string | null;
};

const NOTIFICATION_COLUMNS = [
  'id',
  'type',
  'order_id',
  'customer_email',
  'status',
  'attempts',
  'next_attempt_at',
  'provider_record_id',
  'occurred_at',
  'created_at',
  'updated_at',
].join(', ');

const NOTIFICATIONS_TABLE = 'notifications';
const ATTEMPTS_TABLE = 'notification_attempts';

function mapNotificationRow(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    type: row.type,
    orderId: row.order_id,
    customerEmail: row.customer_email,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at === null ? null : new Date(row.next_attempt_at),
    providerRecordId: row.provider_record_id === null ? null : row.provider_record_id,
    occurredAt: row.occurred_at === null ? null : new Date(row.occurred_at),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * 64 bit FNV-1a hash of the notification identity, computed in the application
 * so that `pg_advisory_lock` keys are stable across processes and replicas.
 */
export function advisoryLockKey(value: string): string {
  const offsetBasis = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let hash = offsetBasis;
  for (const byte of Buffer.from(value, 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return BigInt.asIntN(64, hash).toString();
}

/**
 * PostgreSQL adapter for `notifications-db` (the only database this service owns).
 * Table names come from the authoritative `schema/notifications-schema.sql`; no
 * other service's data is ever touched.
 */
export class PostgresNotificationRepository implements NotificationRepository {
  private readonly pool: Pool;
  private readonly logger: Logger;
  private notificationIdSequence: string | null = null;

  constructor(options: PostgresNotificationRepositoryOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxConnections ?? 10,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
      application_name: 'shopflow-notifications',
    });
    this.logger = options.logger ?? silentLogger;
    this.pool.on('error', (error: Error) => {
      this.logger.error('idle postgres client error', { error: error.message });
    });
  }

  async beginDeliveryForIntent(intent: OrderConfirmationIntent): Promise<BeginDeliveryResult> {
    return this.withTransaction(async (client) => {
      const existing = await this.lockExisting(client, intent);
      if (existing) {
        return { record: mapNotificationRow(existing), created: false };
      }

      const id = await this.nextNotificationId(client);
      const inserted = await client.query<NotificationRow>(
        `INSERT INTO ${NOTIFICATIONS_TABLE}
           (id, type, order_id, customer_email, status, attempts, next_attempt_at, provider_record_id, occurred_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'PENDING', 0, NULL, NULL, $5, now(), now())
         ON CONFLICT (type, order_id) DO NOTHING
         RETURNING ${NOTIFICATION_COLUMNS}`,
        [id, intent.type, intent.orderId, intent.customerEmail, intent.occurredAt],
      );

      const insertedRow = inserted.rows[0];
      if (insertedRow) {
        return { record: mapNotificationRow(insertedRow), created: true };
      }

      // A concurrent dispatch inserted the row first: follow that record instead.
      const winner = await this.lockExisting(client, intent);
      if (!winner) {
        throw new Error(`notification for order id ${intent.orderId} vanished while it was being created`);
      }
      return { record: mapNotificationRow(winner), created: false };
    });
  }

  async acquireDeliveryLock(type: string, orderId: string): Promise<NotificationDeliveryLock> {
    const client = await this.pool.connect();
    const key = advisoryLockKey(`${type}:${orderId}`);
    try {
      await client.query('SELECT pg_advisory_lock($1::bigint)', [key]);
    } catch (error) {
      client.release();
      throw error;
    }
    return {
      release: async (): Promise<void> => {
        try {
          await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
        } catch (error) {
          this.logger.warn('failed to release notification delivery lock', { error: String(error) });
        } finally {
          client.release();
        }
      },
    };
  }

  async findById(notificationId: string): Promise<NotificationRecord | null> {
    const result = await this.pool.query<NotificationRow>(
      `SELECT ${NOTIFICATION_COLUMNS} FROM ${NOTIFICATIONS_TABLE} WHERE id = $1`,
      [notificationId],
    );
    const row = result.rows[0];
    return row ? mapNotificationRow(row) : null;
  }

  async recordDelivered(notificationId: string, success: DeliverySuccess): Promise<NotificationRecord> {
    return this.withTransaction(async (client) => {
      const updated = await client.query<NotificationRow>(
        `UPDATE ${NOTIFICATIONS_TABLE}
            SET status = 'DELIVERED',
                provider_record_id = $2,
                attempts = attempts + 1,
                next_attempt_at = NULL,
                updated_at = now()
          WHERE id = $1 AND status = 'PENDING'
          RETURNING ${NOTIFICATION_COLUMNS}`,
        [notificationId, success.providerRecordId],
      );

      const row = updated.rows[0];
      if (!row) {
        const current = await this.readById(client, notificationId);
        if (!current) {
          throw new Error(`notification ${notificationId} does not exist`);
        }
        // Already DELIVERED: never count or record a second delivery.
        return current;
      }

      const record = mapNotificationRow(row);
      await this.insertAttempt(client, record.id, record.attempts, success.outcome, success.detail);
      return record;
    });
  }

  async recordProviderFailure(notificationId: string, failure: DeliveryFailure): Promise<NotificationRecord> {
    return this.withTransaction(async (client) => {
      const updated = await client.query<NotificationRow>(
        `UPDATE ${NOTIFICATIONS_TABLE}
            SET attempts = attempts + 1,
                next_attempt_at = $2,
                updated_at = now()
          WHERE id = $1 AND status = 'PENDING'
          RETURNING ${NOTIFICATION_COLUMNS}`,
        [notificationId, failure.nextAttemptAt],
      );

      const row = updated.rows[0];
      if (!row) {
        const current = await this.readById(client, notificationId);
        if (!current) {
          throw new Error(`notification ${notificationId} does not exist`);
        }
        return current;
      }

      const record = mapNotificationRow(row);
      await this.insertAttempt(client, record.id, record.attempts, failure.outcome, failure.detail);
      return record;
    });
  }

  async selectDuePending(now: Date, limit: number, maxAttempts: number): Promise<NotificationRecord[]> {
    const result = await this.pool.query<NotificationRow>(
      `SELECT ${NOTIFICATION_COLUMNS}
         FROM ${NOTIFICATIONS_TABLE}
        WHERE status = 'PENDING'
          AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
          AND ($2 = 0 OR attempts < $2)
        ORDER BY created_at ASC, id ASC
        LIMIT $3`,
      [now, maxAttempts, limit],
    );
    return result.rows.map(mapNotificationRow);
  }

  async list(): Promise<NotificationRecord[]> {
    const result = await this.pool.query<NotificationRow>(
      `SELECT ${NOTIFICATION_COLUMNS} FROM ${NOTIFICATIONS_TABLE} ORDER BY created_at ASC, id ASC`,
    );
    return result.rows.map(mapNotificationRow);
  }

  /** Fails loudly when `schema/notifications-schema.sql` was not applied. */
  async verifySchema(): Promise<void> {
    const result = await this.pool.query<SchemaProbeRow>(
      `SELECT to_regclass($1)::text AS notifications, to_regclass($2)::text AS notification_attempts`,
      [NOTIFICATIONS_TABLE, ATTEMPTS_TABLE],
    );
    const row = result.rows[0];
    if (!row?.notifications || !row?.notification_attempts) {
      throw new Error('notifications-db schema is missing: apply schema/notifications-schema.sql first');
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async lockExisting(client: PoolClient, intent: OrderConfirmationIntent): Promise<NotificationRow | null> {
    const result = await client.query<NotificationRow>(
      `SELECT ${NOTIFICATION_COLUMNS} FROM ${NOTIFICATIONS_TABLE} WHERE type = $1 AND order_id = $2 FOR UPDATE`,
      [intent.type, intent.orderId],
    );
    return result.rows[0] ?? null;
  }

  private async readById(client: PoolClient, notificationId: string): Promise<NotificationRecord | null> {
    const result = await client.query<NotificationRow>(
      `SELECT ${NOTIFICATION_COLUMNS} FROM ${NOTIFICATIONS_TABLE} WHERE id = $1`,
      [notificationId],
    );
    const row = result.rows[0];
    return row ? mapNotificationRow(row) : null;
  }

  private async insertAttempt(
    client: PoolClient,
    notificationId: string,
    attempt: number,
    outcome: string,
    detail: string | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ${ATTEMPTS_TABLE} (notification_id, attempt, outcome, detail) VALUES ($1, $2, $3, $4)`,
      [notificationId, attempt, outcome, detail],
    );
  }

  /**
   * Notification ids (`ntf-0001`) are allocated from the attempt-history sequence
   * that the authoritative schema already defines - no extra DDL is required and
   * ids stay monotonic and unique across processes.
   */
  private async nextNotificationId(client: PoolClient): Promise<string> {
    if (this.notificationIdSequence === null) {
      const result = await client.query<{ sequence: string | null }>(
        `SELECT pg_get_serial_sequence($1, 'id') AS sequence`,
        [ATTEMPTS_TABLE],
      );
      const sequence = result.rows[0]?.sequence ?? null;
      if (sequence === null) {
        throw new Error('could not locate the notification id sequence: apply schema/notifications-schema.sql first');
      }
      this.notificationIdSequence = sequence;
    }

    const result = await client.query<{ value: string }>(
      `SELECT nextval($1::regclass)::text AS value`,
      [this.notificationIdSequence],
    );
    const value = result.rows[0]?.value;
    if (value === undefined) {
      throw new Error('could not allocate a notification id');
    }
    return `ntf-${value.padStart(4, '0')}`;
  }

  private async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        this.logger.error('failed to roll back notification transaction', { error: String(rollbackError) });
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
