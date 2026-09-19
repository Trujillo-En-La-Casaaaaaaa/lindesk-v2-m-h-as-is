import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { idempotencyKeyForOrderConfirmation } from '../../domain/notification.js';
import { InMemoryNotificationRepository } from '../../test-support/in-memory-notification-repository.js';
import { getJson, postJson, postRaw } from '../../test-support/test-http-server.js';
import { createUnitHarness, type UnitHarness, type UnitHarnessOptions } from '../../test-support/unit-harness.js';

const PATH = '/notifications/order-confirmations';

describe('notifications HTTP API - unit tests (provider stubbed, no database)', () => {
  const harnesses: UnitHarness[] = [];

  async function newHarness(options: UnitHarnessOptions = {}): Promise<UnitHarness> {
    const harness = await createUnitHarness(options);
    harnesses.push(harness);
    return harness;
  }

  function assertErrorEnvelope(body: unknown, error: string, code: string): void {
    assert.deepEqual(Object.keys(body as Record<string, unknown>).sort(), ['code', 'error']);
    assert.deepEqual(body, { error, code });
  }

  function bodyFor(orderId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { type: 'ORDER_CONFIRMATION', orderId, customerEmail: 'buyer@example.com', ...overrides };
  }

  after(async () => {
    for (const harness of harnesses) {
      await harness.close();
    }
  });

  it('NOTIF-U1 rejects a type other than ORDER_CONFIRMATION with 400 INVALID', async () => {
    const harness = await newHarness();
    const cases: unknown[] = [undefined, 'ORDER_CANCELLED', 'order_confirmation', 42];

    for (const type of cases) {
      const response = await postJson(
        harness.http.baseUrl,
        PATH,
        { type, orderId: 'order-u1', customerEmail: 'buyer@example.com' },
        { 'idempotency-key': idempotencyKeyForOrderConfirmation('order-u1') },
      );
      assert.equal(response.status, 400);
      assertErrorEnvelope(response.body, 'Invalid notification', 'INVALID');
    }

    assert.equal(harness.providerStub.postCount, 0);
    assert.equal(harness.repository.notifications.size, 0);
  });

  it('NOTIF-U2 rejects a missing, empty or non-string orderId with 400 INVALID', async () => {
    const harness = await newHarness();
    const cases: unknown[] = [undefined, null, '', '   ', 42];

    for (const orderId of cases) {
      const response = await postJson(
        harness.http.baseUrl,
        PATH,
        { type: 'ORDER_CONFIRMATION', orderId, customerEmail: 'buyer@example.com' },
        { 'idempotency-key': 'ORDER_CONFIRMATION:x' },
      );
      assert.equal(response.status, 400);
      assertErrorEnvelope(response.body, 'Invalid notification', 'INVALID');
    }

    assert.equal(harness.providerStub.postCount, 0);
    assert.equal(harness.repository.notifications.size, 0);
  });

  it('NOTIF-U3 rejects a customerEmail without @ with 400 INVALID', async () => {
    const harness = await newHarness();
    const cases: unknown[] = [undefined, null, '', 'buyer.example.com', 42];

    for (const customerEmail of cases) {
      const response = await postJson(
        harness.http.baseUrl,
        PATH,
        { type: 'ORDER_CONFIRMATION', orderId: 'order-u3', customerEmail },
        { 'idempotency-key': idempotencyKeyForOrderConfirmation('order-u3') },
      );
      assert.equal(response.status, 400);
      assertErrorEnvelope(response.body, 'Invalid notification', 'INVALID');
    }

    assert.equal(harness.providerStub.postCount, 0);
    assert.equal(harness.repository.notifications.size, 0);
  });

  it('NOTIF-U4 rejects a missing or mismatching Idempotency-Key with 400 INVALID and no provider call', async () => {
    const harness = await newHarness();
    const body = bodyFor('order-u4');

    const missing = await postJson(harness.http.baseUrl, PATH, body);
    assert.equal(missing.status, 400);
    assertErrorEnvelope(missing.body, 'Invalid notification', 'INVALID');

    const mismatching = await postJson(harness.http.baseUrl, PATH, body, {
      'idempotency-key': idempotencyKeyForOrderConfirmation('order-u4-other'),
    });
    assert.equal(mismatching.status, 400);
    assertErrorEnvelope(mismatching.body, 'Invalid notification', 'INVALID');

    const wrongShape = await postJson(harness.http.baseUrl, PATH, body, { 'idempotency-key': 'order-u4' });
    assert.equal(wrongShape.status, 400);
    assertErrorEnvelope(wrongShape.body, 'Invalid notification', 'INVALID');

    assert.equal(harness.providerStub.postCount, 0);
    assert.equal(harness.repository.notifications.size, 0);

    // Control: the exact key is accepted.
    const accepted = await postJson(harness.http.baseUrl, PATH, body, {
      'idempotency-key': idempotencyKeyForOrderConfirmation('order-u4'),
    });
    assert.equal(accepted.status, 201);
    assert.equal(harness.providerStub.postCount, 1);
  });

  it('NOTIF-U5 replays an already DELIVERED notification with 200, x-idempotent-replay and no provider call', async () => {
    const harness = await newHarness();
    const body = bodyFor('order-u5');
    const key = idempotencyKeyForOrderConfirmation('order-u5');

    const first = await postJson(harness.http.baseUrl, PATH, body, { 'idempotency-key': key });
    assert.equal(first.status, 201);
    assert.equal(first.body.status, 'DELIVERED');
    assert.equal(first.headers.get('x-idempotent-replay'), null);
    const postsAfterFirstDelivery = harness.providerStub.postCount;

    const replay = await postJson(harness.http.baseUrl, PATH, body, { 'idempotency-key': key });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
    assert.deepEqual(replay.body, first.body);

    const secondReplay = await postJson(harness.http.baseUrl, PATH, body, { 'idempotency-key': key });
    assert.equal(secondReplay.status, 200);
    assert.equal(secondReplay.headers.get('x-idempotent-replay'), 'true');

    assert.equal(harness.providerStub.postCount, postsAfterFirstDelivery);
    assert.equal(harness.repository.attempts.length, 1);
    assert.equal(harness.repository.notifications.size, 1);
  });

  it('NOTIF-U6 answers 502 PROVIDER_UNAVAILABLE on provider failure and keeps the record PENDING', async () => {
    const harness = await newHarness();
    harness.providerStub.setFailNextRequests(1);

    const response = await postJson(harness.http.baseUrl, PATH, bodyFor('order-u6'), {
      'idempotency-key': idempotencyKeyForOrderConfirmation('order-u6'),
    });

    assert.equal(response.status, 502);
    assertErrorEnvelope(response.body, 'Notification provider unavailable', 'PROVIDER_UNAVAILABLE');

    const record = harness.repository.findByTypeAndOrder('ORDER_CONFIRMATION', 'order-u6');
    assert.ok(record, 'the record must exist even though the provider failed');
    assert.equal(record.status, 'PENDING');
    assert.equal(record.providerRecordId, null);
    assert.equal(record.attempts, 1);
    assert.notEqual(record.nextAttemptAt, null);
    assert.ok((record.nextAttemptAt?.getTime() ?? 0) > Date.now() - 1000);
    assert.equal(harness.repository.attemptsFor(record.id).map((attempt) => attempt.outcome).join(','), 'PROVIDER_ERROR');
    assert.equal(harness.providerStub.notifications.length, 0);
  });

  it('NOTIF-U8 skips the POST and reconciles when the provider already holds the order id', async () => {
    const harness = await newHarness();
    const body = bodyFor('order-u8');
    const key = idempotencyKeyForOrderConfirmation('order-u8');

    // First attempt fails, the record stays PENDING.
    harness.providerStub.setFailNextRequests(1);
    const failed = await postJson(harness.http.baseUrl, PATH, body, { 'idempotency-key': key });
    assert.equal(failed.status, 502);
    assert.equal(harness.providerStub.postCount, 1);

    // The provider holds the message (as it would after an ambiguous failure).
    const providerRecord = harness.providerStub.seedNotification({ orderId: 'order-u8' });
    assert.equal(harness.providerStub.notificationsForOrder('order-u8').length, 1);

    const retry = await postJson(harness.http.baseUrl, PATH, body, { 'idempotency-key': key });
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get('x-idempotent-replay'), 'true');
    assert.equal(retry.body.status, 'DELIVERED');
    assert.equal(retry.body.providerRecordId, providerRecord.id);

    // No second POST: the reconcile check closed the ambiguous-failure window.
    assert.equal(harness.providerStub.postCount, 1);
    assert.equal(harness.providerStub.notificationsForOrder('order-u8').length, 1);

    const record = harness.repository.findByTypeAndOrder('ORDER_CONFIRMATION', 'order-u8');
    assert.ok(record);
    assert.equal(record.status, 'DELIVERED');
    assert.equal(record.providerRecordId, providerRecord.id);
    assert.equal(
      harness.repository.attemptsFor(record.id).map((attempt) => attempt.outcome).join(','),
      'PROVIDER_ERROR,RECONCILED',
    );
  });

  it('NOTIF-U9 forwards exactly the three legacy provider fields', async () => {
    const harness = await newHarness();
    const occurredAt = '2026-01-01T00:00:00.000Z';

    const response = await postJson(
      harness.http.baseUrl,
      PATH,
      { type: 'ORDER_CONFIRMATION', orderId: 'order-u9', customerEmail: 'buyer@example.com', occurredAt },
      { 'idempotency-key': idempotencyKeyForOrderConfirmation('order-u9') },
    );
    assert.equal(response.status, 201);
    assert.equal(harness.providerStub.postCount, 1);

    const [posted] = harness.providerStub.postedBodies();
    assert.ok(posted);
    assert.deepEqual(Object.keys(posted).sort(), ['customerEmail', 'orderId', 'type']);
    assert.deepEqual(posted, { type: 'ORDER_CONFIRMATION', orderId: 'order-u9', customerEmail: 'buyer@example.com' });

    const request = harness.providerStub.requests.find((candidate) => candidate.method === 'POST');
    assert.ok(request);
    assert.deepEqual(Object.keys(JSON.parse(request.rawBody) as Record<string, unknown>).sort(), ['customerEmail', 'orderId', 'type']);

    // occurredAt is stored locally only.
    const record = harness.repository.findByTypeAndOrder('ORDER_CONFIRMATION', 'order-u9');
    assert.ok(record?.occurredAt);
    assert.equal(record.occurredAt.toISOString(), occurredAt);
  });

  it('NOTIF-U10 GET /health answers {"ok":true} without calling the provider or the database', async () => {
    const harness = await newHarness();

    const response = await getJson(harness.http.baseUrl, '/health');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true });
    assert.equal(response.headers.get('content-type')?.startsWith('application/json'), true);
    assert.equal(harness.providerStub.requests.length, 0);
    assert.equal(harness.repository.readCount, 0);
  });

  it('NOTIF-U11 uses the two-field error envelope and echoes x-correlation-id', async () => {
    const harness = await newHarness();

    const invalid = await postJson(
      harness.http.baseUrl,
      PATH,
      { type: 'NOPE', orderId: 'order-u11', customerEmail: 'buyer@example.com' },
      { 'x-correlation-id': 'corr-123' },
    );
    assert.equal(invalid.status, 400);
    assertErrorEnvelope(invalid.body, 'Invalid notification', 'INVALID');
    assert.equal(invalid.headers.get('x-correlation-id'), 'corr-123');

    const notFound = await getJson(harness.http.baseUrl, '/unknown', { 'x-correlation-id': 'corr-456' });
    assert.equal(notFound.status, 404);
    assertErrorEnvelope(notFound.body, 'Not found', 'NOT_FOUND');
    assert.equal(notFound.headers.get('x-correlation-id'), 'corr-456');

    const healthy = await getJson(harness.http.baseUrl, '/health', { 'x-correlation-id': 'corr-789' });
    assert.equal(healthy.headers.get('x-correlation-id'), 'corr-789');

    const malformed = await postRaw(harness.http.baseUrl, PATH, '{"type":', {
      'idempotency-key': idempotencyKeyForOrderConfirmation('order-u11'),
    });
    assert.equal(malformed.status, 400);
    assertErrorEnvelope(malformed.body, 'Invalid notification', 'INVALID');
  });

  it('NOTIF-U12 answers 500 {"error":"Internal server error"} for unexpected failures', async () => {
    const repository = new InMemoryNotificationRepository();
    const harness = await newHarness({ repository });
    repository.failWrites = new Error('notifications-db is unreachable');

    const response = await postJson(harness.http.baseUrl, PATH, bodyFor('order-u12'), {
      'idempotency-key': idempotencyKeyForOrderConfirmation('order-u12'),
    });
    assert.equal(response.status, 500);
    assertErrorEnvelope(response.body, 'Internal server error', 'INTERNAL');

    repository.failWrites = null;
    repository.failReads = new Error('notifications-db is unreachable');
    const listed = await getJson(harness.http.baseUrl, '/notifications');
    assert.equal(listed.status, 500);
    assertErrorEnvelope(listed.body, 'Internal server error', 'INTERNAL');
  });

  it('NOTIF-U13 disables the delivery worker loop by configuration', async () => {
    const disabled = await newHarness({ deliveryWorkerEnabled: false });
    assert.equal(disabled.service.worker, null);

    disabled.providerStub.setFailNextRequests(1);
    const response = await postJson(disabled.http.baseUrl, PATH, bodyFor('order-u13'), {
      'idempotency-key': idempotencyKeyForOrderConfirmation('order-u13'),
    });
    assert.equal(response.status, 502);

    const record = disabled.repository.findByTypeAndOrder('ORDER_CONFIRMATION', 'order-u13');
    assert.ok(record);
    assert.equal(record.status, 'PENDING');
    // Nothing retried it: without the worker loop the unit tests never sleep.
    assert.equal(disabled.providerStub.postCount, 1);

    const enabled = await newHarness({ deliveryWorkerEnabled: true });
    assert.equal(enabled.service.worker?.isRunning, false);
  });

  it('NOTIF-U15 keeps the legacy timeout semantics and records PROVIDER_TIMEOUT', async () => {
    const harness = await newHarness({ providerTimeoutMs: 120 });
    harness.providerStub.setResponseDelayMs(2000);

    const started = Date.now();
    const response = await postJson(harness.http.baseUrl, PATH, bodyFor('order-u15'), {
      'idempotency-key': idempotencyKeyForOrderConfirmation('order-u15'),
    });
    const elapsed = Date.now() - started;

    assert.equal(response.status, 502);
    assertErrorEnvelope(response.body, 'Notification provider unavailable', 'PROVIDER_UNAVAILABLE');
    assert.ok(elapsed < 1500, `the request must abort on the configured timeout, took ${elapsed} ms`);

    const record = harness.repository.findByTypeAndOrder('ORDER_CONFIRMATION', 'order-u15');
    assert.ok(record);
    assert.equal(record.status, 'PENDING');
    assert.equal(harness.repository.attemptsFor(record.id).map((attempt) => attempt.outcome).join(','), 'PROVIDER_TIMEOUT');
  });
});
