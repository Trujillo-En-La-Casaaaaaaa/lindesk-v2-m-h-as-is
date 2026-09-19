import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { NotificationServiceConfig } from '../config.js';
import { idempotencyKeyForOrderConfirmation } from '../domain/notification.js';
import { silentLogger } from '../observability/logger.js';
import { createNotificationService, type NotificationService } from '../service.js';
import { StubNotificationProvider } from '../test-support/provider-stub.js';
import { createTestDatabase, delay, queryRows, type TestDatabase } from '../test-support/postgres-test-database.js';
import { getJson, postJson, startTestHttpServer, type TestHttpServer } from '../test-support/test-http-server.js';

type NotificationRow = {
  id: string;
  type: string;
  order_id: string;
  customer_email: string;
  status: string;
  attempts: number;
  next_attempt_at: Date | null;
  provider_record_id: string | null;
  occurred_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type AttemptRow = {
  notification_id: string;
  attempt: number;
  outcome: string;
  detail: string | null;
};

const DOCUMENTED_FIELDS = ['attempts', 'createdAt', 'customerEmail', 'id', 'orderId', 'providerRecordId', 'status', 'type'];

function firstRow<T>(items: T[]): T {
  const value = items[0];
  assert.ok(value !== undefined, 'expected at least one row');
  return value;
}

describe('notifications service integration (real PostgreSQL 17 + provider stub)', () => {
  let database: TestDatabase;
  let providerStub: StubNotificationProvider;
  let service: NotificationService | null = null;
  let http: TestHttpServer | null = null;

  function configFor(overrides: Partial<NotificationServiceConfig> = {}): NotificationServiceConfig {
    return {
      port: 0,
      databaseUrl: database.url,
      providerUrl: providerStub.baseUrl,
      providerTimeoutMs: 3000,
      deliveryIntervalMs: 100,
      deliveryBackoffBaseMs: 50,
      deliveryMaxAttempts: 0,
      deliveryWorkerEnabled: false,
      ...overrides,
    };
  }

  async function startService(overrides: Partial<NotificationServiceConfig> = {}): Promise<void> {
    assert.equal(service, null, 'a notification service is already running');
    service = createNotificationService(configFor(overrides), { logger: silentLogger });
    http = await startTestHttpServer(service.app);
    await service.start();
  }

  async function stopService(): Promise<void> {
    if (http !== null) {
      await http.close();
      http = null;
    }
    if (service !== null) {
      await service.stop();
      service = null;
    }
  }

  function baseUrl(): string {
    assert.ok(http !== null, 'the notification service is not running');
    return http.baseUrl;
  }

  function dispatch(orderId: string, overrides: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    return postJson(
      baseUrl(),
      '/notifications/order-confirmations',
      {
        type: 'ORDER_CONFIRMATION',
        orderId,
        customerEmail: 'buyer@example.com',
        occurredAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
      },
      { 'idempotency-key': idempotencyKeyForOrderConfirmation(orderId), ...headers },
    );
  }

  async function notificationRows(orderId: string): Promise<NotificationRow[]> {
    return queryRows<NotificationRow>(database.url, 'SELECT * FROM notifications WHERE order_id = $1', [orderId]);
  }

  async function attemptRows(notificationId: string): Promise<AttemptRow[]> {
    return queryRows<AttemptRow>(
      database.url,
      'SELECT notification_id, attempt, outcome, detail FROM notification_attempts WHERE notification_id = $1 ORDER BY attempt ASC',
      [notificationId],
    );
  }

  async function waitForStatus(orderId: string, status: string, timeoutMs: number): Promise<NotificationRow> {
    const deadline = Date.now() + timeoutMs;
    let last: NotificationRow | null = null;
    while (Date.now() < deadline) {
      last = (await notificationRows(orderId))[0] ?? null;
      if (last?.status === status) {
        return last;
      }
      await delay(25);
    }
    throw new Error(`notification for order ${orderId} did not reach ${status} within ${timeoutMs} ms (last: ${last?.status ?? 'missing'})`);
  }

  before(async () => {
    database = await createTestDatabase();
    providerStub = new StubNotificationProvider();
    await providerStub.start();
    console.log(`[integration] notifications-db: ${database.description}`);
    await startService();
  });

  after(async () => {
    await stopService();
    await providerStub.stop();
    await database.dispose();
  });

  beforeEach(async () => {
    await stopService();
    providerStub.reset();
    await providerStub.ensureListening();
    await startService();
    await database.reset();
  });

  it('NOTIF-I1 first delivery stores provider_record_id, DELIVERED and exactly one attempt row', async () => {
    const orderId = 'order-i1';

    const response = await dispatch(orderId);

    assert.equal(response.status, 201);
    assert.equal(response.headers.get('x-idempotent-replay'), null);
    assert.deepEqual(Object.keys(response.body).sort(), DOCUMENTED_FIELDS);
    assert.match(response.body.id, /^ntf-\d+$/);
    assert.equal(response.body.type, 'ORDER_CONFIRMATION');
    assert.equal(response.body.orderId, orderId);
    assert.equal(response.body.customerEmail, 'buyer@example.com');
    assert.equal(response.body.status, 'DELIVERED');
    assert.equal(response.body.attempts, 1);
    assert.equal(response.body.providerRecordId, 'notification-0001');

    const row = firstRow(await notificationRows(orderId));
    assert.equal(row.id, response.body.id);
    assert.equal(row.status, 'DELIVERED');
    assert.equal(row.provider_record_id, 'notification-0001');
    assert.equal(row.attempts, 1);
    assert.equal(row.next_attempt_at, null);

    const attempts = await attemptRows(row.id);
    assert.equal(attempts.length, 1, 'exactly one attempt row after the first delivery');
    assert.equal(firstRow(attempts).attempt, 1);
    assert.equal(firstRow(attempts).outcome, 'DELIVERED');

    // Provider side: one record, and the payload keeps exactly the legacy fields.
    assert.equal(providerStub.postCount, 1);
    assert.equal(providerStub.notifications.length, 1);
    assert.deepEqual(providerStub.notifications[0], {
      id: 'notification-0001',
      type: 'ORDER_CONFIRMATION',
      orderId,
      customerEmail: 'buyer@example.com',
    });
    assert.deepEqual(Object.keys(firstRow(providerStub.postedBodies())).sort(), ['customerEmail', 'orderId', 'type']);
  });

  it('NOTIF-I2 repeated dispatch, including after an ambiguous failure, yields one provider record and one DELIVERED record', async () => {
    const orderId = 'order-i2';

    const first = await dispatch(orderId);
    assert.equal(first.status, 201);

    const replay = await dispatch(orderId);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
    assert.equal(replay.body.id, first.body.id);
    assert.deepEqual(replay.body, first.body);

    const third = await dispatch(orderId);
    assert.equal(third.status, 200);

    assert.equal(providerStub.notificationsForOrder(orderId).length, 1);
    assert.equal(providerStub.postsForOrder(orderId).length, 1);
    assert.equal((await notificationRows(orderId)).length, 1);

    // Ambiguous failure: the provider accepted the message but the response was lost.
    const ambiguousOrderId = 'order-i2-ambiguous';
    providerStub.setDropNextResponses(1);

    const dropped = await dispatch(ambiguousOrderId);
    assert.equal(dropped.status, 502);
    assert.deepEqual(dropped.body, { error: 'Notification provider unavailable', code: 'PROVIDER_UNAVAILABLE' });

    const pending = firstRow(await notificationRows(ambiguousOrderId));
    assert.equal(pending.status, 'PENDING');
    assert.equal(pending.provider_record_id, null);
    assert.equal(pending.attempts, 1);
    assert.equal(providerStub.notificationsForOrder(ambiguousOrderId).length, 1, 'the provider did accept the message');

    // The caller retries (shopflow-orders retries from its outbox).
    const retry = await dispatch(ambiguousOrderId);
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get('x-idempotent-replay'), 'true');
    assert.equal(retry.body.status, 'DELIVERED');
    assert.equal(retry.body.providerRecordId, firstRow(providerStub.notificationsForOrder(ambiguousOrderId)).id);

    assert.equal(providerStub.postsForOrder(ambiguousOrderId).length, 1, 'the reconcile check must prevent a second POST');
    assert.equal(providerStub.notificationsForOrder(ambiguousOrderId).length, 1);

    const delivered = firstRow(await notificationRows(ambiguousOrderId));
    assert.equal(delivered.status, 'DELIVERED');
    assert.equal(delivered.attempts, 2);
    assert.equal(
      (await attemptRows(delivered.id)).map((attempt) => attempt.outcome).join(','),
      'PROVIDER_ERROR,RECONCILED',
    );

    const all = await queryRows<{ order_id: string }>(database.url, 'SELECT order_id FROM notifications ORDER BY order_id');
    assert.equal(all.length, 2, 'one notification record per order, no duplicates');
  });

  it('NOTIF-I3 provider unreachable -> 502 PENDING; the worker delivers once the provider returns', async () => {
    const orderId = 'order-i3';

    await providerStub.stopListening();
    const failed = await dispatch(orderId);

    assert.equal(failed.status, 502);
    assert.deepEqual(failed.body, { error: 'Notification provider unavailable', code: 'PROVIDER_UNAVAILABLE' });

    const pending = firstRow(await notificationRows(orderId));
    assert.equal(pending.status, 'PENDING');
    assert.equal(pending.provider_record_id, null);
    assert.equal(pending.attempts, 1);
    assert.notEqual(pending.next_attempt_at, null, 'a retry must be scheduled');
    assert.equal((await attemptRows(pending.id)).map((attempt) => attempt.outcome).join(','), 'PROVIDER_ERROR');
    assert.equal(providerStub.notificationsForOrder(orderId).length, 0);

    // No worker is running yet, so the record really is durable state, not a queue.
    assert.equal(firstRow(await notificationRows(orderId)).status, 'PENDING');

    await providerStub.ensureListening();
    await stopService();

    const startedAt = Date.now();
    await startService({ deliveryWorkerEnabled: true, deliveryIntervalMs: 100 });
    const delivered = await waitForStatus(orderId, 'DELIVERED', 5000);
    const elapsed = Date.now() - startedAt;

    assert.equal(delivered.provider_record_id, 'notification-0001');
    assert.equal(delivered.attempts, 2);
    assert.ok(elapsed <= 2000, `the worker must deliver within DELIVERY_INTERVAL_MS bounds, took ${elapsed} ms`);
    assert.equal(providerStub.postsForOrder(orderId).length, 1);
    assert.equal(providerStub.notificationsForOrder(orderId).length, 1);
    assert.equal(
      (await attemptRows(delivered.id)).map((attempt) => attempt.outcome).join(','),
      'PROVIDER_ERROR,DELIVERED',
    );
  });

  it('NOTIF-I4 GET /notifications lists records with the documented fields, oldest first', async () => {
    await dispatch('order-i4-a');
    await dispatch('order-i4-b');

    const response = await getJson(baseUrl(), '/notifications');
    assert.equal(response.status, 200);
    assert.equal(Array.isArray(response.body), true);
    assert.equal(response.body.length, 2);

    for (const record of response.body) {
      assert.deepEqual(Object.keys(record).sort(), DOCUMENTED_FIELDS);
      assert.match(record.id, /^ntf-\d+$/);
      assert.equal(record.type, 'ORDER_CONFIRMATION');
      assert.equal(record.status, 'DELIVERED');
      assert.equal(record.attempts, 1);
      assert.equal(record.customerEmail, 'buyer@example.com');
      assert.match(record.providerRecordId, /^notification-\d+$/);
      assert.equal(typeof record.createdAt, 'string');
      assert.equal(Number.isNaN(Date.parse(record.createdAt)), false);
    }

    assert.deepEqual(
      response.body.map((record: { orderId: string }) => record.orderId),
      ['order-i4-a', 'order-i4-b'],
    );
    assert.ok(Date.parse(response.body[0].createdAt) <= Date.parse(response.body[1].createdAt));

    // A PENDING record exposes its orchestration state as well.
    providerStub.setFailNextRequests(1);
    await dispatch('order-i4-c');

    const listed = await getJson(baseUrl(), '/notifications');
    assert.equal(listed.body.length, 3);
    const pending = listed.body[2];
    assert.equal(pending.orderId, 'order-i4-c');
    assert.equal(pending.status, 'PENDING');
    assert.equal(pending.providerRecordId, null);
    assert.equal(pending.attempts, 1);
  });

  it('NOTIF-I5 serializes concurrent dispatches of the same notification', async () => {
    const orderId = 'order-i5';

    const [left, right] = await Promise.all([dispatch(orderId), dispatch(orderId)]);

    const statuses = [left.status, right.status].sort();
    assert.deepEqual(statuses, [200, 201], 'exactly one dispatch creates the record, the other replays it');
    const replay = left.status === 200 ? left : right;
    assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
    assert.equal(left.body.id, right.body.id);

    assert.equal(providerStub.postsForOrder(orderId).length, 1, 'one provider call for one logical notification');
    assert.equal(providerStub.notificationsForOrder(orderId).length, 1);

    const rows = await notificationRows(orderId);
    assert.equal(rows.length, 1);
    assert.equal(firstRow(rows).status, 'DELIVERED');
    assert.equal(firstRow(rows).attempts, 1);
    assert.equal((await attemptRows(firstRow(rows).id)).length, 1);
  });

  it('NOTIF-I6 a PENDING record committed before the provider call is delivered by a later service instance', async () => {
    const orderId = 'order-i6';

    // Crash window: the record was committed as PENDING, the provider was never called.
    await queryRows(
      database.url,
      `INSERT INTO notifications (id, type, order_id, customer_email, status, attempts, next_attempt_at, occurred_at)
       VALUES ($1, 'ORDER_CONFIRMATION', $2, $3, 'PENDING', 0, NULL, NULL)`,
      ['ntf-9001', orderId, 'buyer@example.com'],
    );
    assert.equal(providerStub.postCount, 0);

    await stopService();
    await startService({ deliveryWorkerEnabled: true, deliveryIntervalMs: 100 });

    const delivered = await waitForStatus(orderId, 'DELIVERED', 5000);

    assert.equal(delivered.id, 'ntf-9001');
    assert.equal(delivered.provider_record_id, 'notification-0001');
    assert.equal(delivered.attempts, 1);
    assert.equal(providerStub.postsForOrder(orderId).length, 1);
    assert.equal(providerStub.notificationsForOrder(orderId).length, 1);
    assert.equal((await attemptRows(delivered.id)).map((attempt) => attempt.outcome).join(','), 'DELIVERED');
  });
});
