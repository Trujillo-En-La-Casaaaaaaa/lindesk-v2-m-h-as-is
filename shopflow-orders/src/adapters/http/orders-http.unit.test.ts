/**
 * ORD-U* - the unit layer of `POST /orders`, `GET /orders/:id`, `POST /orders/:id/ship` and the
 * outbox.
 *
 * No database, no network and no worker timers: the harness wires the production HTTP adapter, the
 * production application services and the production domain rules over recording doubles of the two
 * frozen contracts and an in-memory persistence double.
 *
 * ORD-U8 (compensation after a failed local transaction) lives next to the saga service in
 * `src/application/saga/order-creation.unit.test.ts`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CONFIG_DEFAULTS } from '../../config.js';
import { RecordedInventoryClient, decreaseWith } from '../../test-support/recorded-clients.js';
import { startUnitHarness } from '../../test-support/unit-harness.js';

const INVALID_ENVELOPE = {
  error: 'A product, positive whole quantity, and valid email are required',
  code: 'INVALID',
};
const INSUFFICIENT_STOCK_ENVELOPE = { error: 'Insufficient stock', code: 'INSUFFICIENT_STOCK' };
const PRODUCT_NOT_FOUND_ENVELOPE = { error: 'Product not found', code: 'NOT_FOUND' };
const ORDER_NOT_FOUND_ENVELOPE = { error: 'Order not found', code: 'NOT_FOUND' };
const INVALID_STATUS_ENVELOPE = { error: 'Only CONFIRMED orders can be shipped', code: 'INVALID_STATUS' };
const INTERNAL_ENVELOPE = { error: 'Internal server error' };
const UNAVAILABLE_ENVELOPE = { error: 'Upstream service unavailable', code: 'UNAVAILABLE' };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const VALID_BODY = { productId: 'product-a', quantity: 3, customerEmail: 'buyer@example.com' };

function asRecord(body: unknown): Record<string, unknown> {
  assert.equal(typeof body, 'object');
  assert.notEqual(body, null);
  return body as Record<string, unknown>;
}

test('ORD-U1 POST /orders answers 201 CONFIRMED with the inventory price snapshot and a durable PENDING outbox row', async (t) => {
  const harness = await startUnitHarness();
  t.after(() => harness.close());

  // The outbox row is born PENDING inside the same local transaction as the order row; it is still
  // PENDING when the confirmation is dispatched, which is what makes the intent durable.
  let outboxStateAtDispatch: string | null = null;
  harness.notifications.setHandler(() => {
    outboxStateAtDispatch = harness.store.outbox.get(1)?.state ?? null;
    return { delivered: true };
  });

  const response = await harness.post('/orders', VALID_BODY);
  assert.equal(response.status, 201, response.text);
  const order = asRecord(response.body);

  assert.equal(order['status'], 'CONFIRMED');
  assert.equal(order['customerEmail'], 'buyer@example.com');
  assert.equal(order['productId'], 'product-a');
  assert.equal(order['quantity'], 3);
  // The inventory price snapshot is 1200 cents: 3 * 1200, never recomputed from a catalog.
  assert.equal(order['totalCents'], 3600);
  assert.match(String(order['id']), UUID_PATTERN);
  assert.match(String(order['createdAt']), ISO_PATTERN);
  assert.deepEqual(
    Object.keys(order).sort(),
    ['createdAt', 'customerEmail', 'id', 'productId', 'quantity', 'status', 'totalCents'],
  );

  const stored = harness.store.orders.get(String(order['id']));
  assert.ok(stored, 'the order must be persisted');
  assert.equal(stored.totalCents, 3600);

  let operation = harness.store.operations.get(String(order['id']));
  assert.ok(operation, 'the saga row must exist for the order');
  assert.equal(operation.state, 'COMPLETED');
  assert.equal(operation.decrementOutcome, 'DECREMENTED');
  assert.equal(operation.attempts, 1);
  assert.equal(operation.clientIdempotencyKey, null);

  assert.equal(outboxStateAtDispatch, 'PENDING', 'the outbox row must be PENDING when it is dispatched');
  const entry = harness.store.outbox.get(1);
  assert.ok(entry, 'exactly one outbox row must exist');
  assert.deepEqual(entry.payload, {
    type: 'ORDER_CONFIRMATION',
    orderId: order['id'],
    customerEmail: 'buyer@example.com',
  });
  assert.equal(entry.state, 'DELIVERED', 'the successful inline dispatch marks the durable intent delivered');

  // The inventory call carries the order id as its idempotency key (the ledger key).
  assert.equal(harness.inventory.decrementCalls.length, 1);
  const decrementCall = harness.inventory.decrementCalls[0];
  assert.ok(decrementCall);
  assert.equal(decrementCall.orderId, order['id'], 'the order id is the inventory idempotency key');
  assert.equal(decrementCall.productId, 'product-a');
  assert.equal(decrementCall.quantity, 3);
  assert.match(String(decrementCall.correlationId), UUID_PATTERN);
  assert.equal(
    response.headers.get('x-correlation-id'),
    decrementCall.correlationId,
    'the correlation id is echoed to the caller and forwarded upstream',
  );

  t.diagnostic(`ORD-U1 POST /orders -> 201 ${JSON.stringify(order)}, outbox ${entry.state}`);
});

test('ORD-U2 insufficient stock answers 400 INSUFFICIENT_STOCK with no order, no outbox row and an aborted saga', async (t) => {
  const harness = await startUnitHarness({
    inventory: new RecordedInventoryClient({ decrement: () => ({ kind: 'INSUFFICIENT_STOCK' }) }),
  });
  t.after(() => harness.close());

  const response = await harness.post('/orders', VALID_BODY);

  assert.equal(response.status, 400);
  assert.deepEqual(asRecord(response.body), INSUFFICIENT_STOCK_ENVELOPE);
  assert.equal(harness.store.orders.size, 0, 'no order row may be created');
  assert.equal(harness.store.outbox.size, 0, 'no notification may be queued');
  assert.equal(harness.notifications.dispatches.length, 0, 'no notification may be dispatched');
  assert.equal(harness.inventory.decrementCalls.length, 1);
  assert.equal(harness.inventory.releaseCalls.length, 0, 'a rejected decrement must not be compensated');

  const operation = [...harness.store.operations.values()][0];
  assert.ok(operation, 'the saga row is the durable record of the rejected attempt');
  assert.equal(operation.state, 'ABORTED_INSUFFICIENT_STOCK');
  assert.equal(operation.decrementOutcome, 'INSUFFICIENT_STOCK');
  assert.equal(operation.attempts, 1);
});

test('ORD-U3 unknown orders answer 404 NOT_FOUND and an unknown product answers 404 NOT_FOUND without an order', async (t) => {
  const harness = await startUnitHarness({
    inventory: new RecordedInventoryClient({
      decrement: (request) =>
        request.productId === 'product-unknown'
          ? { kind: 'PRODUCT_NOT_FOUND' }
          : decreaseWith()(request, 1),
    }),
  });
  t.after(() => harness.close());

  assert.deepEqual(asRecord((await harness.request(`/orders/${randomUUID()}`)).body), ORDER_NOT_FOUND_ENVELOPE);

  // A path parameter that can never be a UUID is the same "unknown order", never a 500.
  const malformed = await harness.request('/orders/not-an-order-id');
  assert.equal(malformed.status, 404);
  assert.deepEqual(asRecord(malformed.body), ORDER_NOT_FOUND_ENVELOPE);

  const unknownOperations = await harness.request(`/orders/${randomUUID()}/operations`);
  assert.equal(unknownOperations.status, 404);
  assert.deepEqual(asRecord(unknownOperations.body), ORDER_NOT_FOUND_ENVELOPE);

  const unknownProduct = await harness.post('/orders', {
    productId: 'product-unknown',
    quantity: 1,
    customerEmail: 'buyer@example.com',
  });
  assert.equal(unknownProduct.status, 404);
  assert.deepEqual(asRecord(unknownProduct.body), PRODUCT_NOT_FOUND_ENVELOPE);
  assert.equal(harness.store.orders.size, 0, 'an unknown product must not create an order row');
  assert.equal(harness.store.outbox.size, 0);
  const operation = [...harness.store.operations.values()][0];
  assert.equal(operation?.state, 'ABORTED_NOT_FOUND');
  assert.equal(operation?.decrementOutcome, 'NOT_FOUND');
});

test('ORD-U4 ship transitions CONFIRMED -> SHIPPED once and touches neither inventory nor notifications', async (t) => {
  const harness = await startUnitHarness();
  t.after(() => harness.close());

  const created = await harness.post('/orders', VALID_BODY);
  assert.equal(created.status, 201);
  const orderId = String(asRecord(created.body)['id']);
  const decrementCalls = harness.inventory.decrementCalls.length;
  const releaseCalls = harness.inventory.releaseCalls.length;
  const dispatches = harness.notifications.dispatches.length;

  const shipped = await harness.post(`/orders/${orderId}/ship`, {});
  assert.equal(shipped.status, 200);
  assert.equal(asRecord(shipped.body)['status'], 'SHIPPED');
  assert.equal(asRecord(shipped.body)['id'], orderId);

  const detail = await harness.request(`/orders/${orderId}`);
  assert.equal(detail.status, 200);
  assert.equal(asRecord(detail.body)['status'], 'SHIPPED', 'the transition must be persisted');

  const again = await harness.post(`/orders/${orderId}/ship`, {});
  assert.equal(again.status, 409);
  assert.deepEqual(asRecord(again.body), INVALID_STATUS_ENVELOPE);

  const unknown = await harness.post(`/orders/${randomUUID()}/ship`, {});
  assert.equal(unknown.status, 404);
  assert.deepEqual(asRecord(unknown.body), ORDER_NOT_FOUND_ENVELOPE);

  assert.equal(harness.inventory.decrementCalls.length, decrementCalls, 'shipping must not call inventory');
  assert.equal(harness.inventory.releaseCalls.length, releaseCalls);
  assert.equal(harness.notifications.dispatches.length, dispatches, 'shipping must not notify');
});

test('ORD-U5 invalid input variants answer 400 with the legacy message and start no saga', async (t) => {
  const harness = await startUnitHarness();
  t.after(() => harness.close());

  const variants: unknown[] = [
    undefined,
    {},
    { ...VALID_BODY, productId: undefined },
    { ...VALID_BODY, productId: '' },
    { ...VALID_BODY, productId: '   ' },
    { ...VALID_BODY, productId: 42 },
    { ...VALID_BODY, quantity: undefined },
    { ...VALID_BODY, quantity: 0 },
    { ...VALID_BODY, quantity: -3 },
    { ...VALID_BODY, quantity: 1.5 },
    { ...VALID_BODY, quantity: '3' },
    { ...VALID_BODY, quantity: null },
    { ...VALID_BODY, customerEmail: undefined },
    { ...VALID_BODY, customerEmail: 'nope' },
    { ...VALID_BODY, customerEmail: 'buyer@example' },
    { ...VALID_BODY, customerEmail: 'buyer at example.com' },
    [VALID_BODY],
    'product-a',
  ];

  for (const variant of variants) {
    const response = await harness.post('/orders', variant);
    assert.equal(response.status, 400, `variant ${JSON.stringify(variant)}: ${response.text}`);
    assert.deepEqual(asRecord(response.body), INVALID_ENVELOPE, `variant ${JSON.stringify(variant)}`);
  }

  // A malformed payload is the same rejection the legacy service answered.
  const malformed = await harness.request('/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"productId":',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(asRecord(malformed.body), INVALID_ENVELOPE);

  // An oversized client key must not become unbounded state.
  const oversizedKey = 'k'.repeat(256);
  const oversized = await harness.post('/orders', VALID_BODY, { 'Idempotency-Key': oversizedKey });
  assert.equal(oversized.status, 400);
  assert.deepEqual(asRecord(oversized.body), INVALID_ENVELOPE);

  assert.equal(harness.store.operations.size, 0, 'no rejected variant may start a saga');
  assert.equal(harness.inventory.decrementCalls.length, 0, 'no rejected variant may call inventory');
  assert.equal(harness.store.orders.size, 0);
});

test('ORD-U6 a repeated client Idempotency-Key replays the order without a second saga or decrement', async (t) => {
  const harness = await startUnitHarness();
  t.after(() => harness.close());

  const key = `ORD-U6-${randomUUID()}`;
  const first = await harness.post('/orders', VALID_BODY, { 'Idempotency-Key': key });
  assert.equal(first.status, 201, first.text);
  assert.equal(first.headers.get('x-idempotent-replay'), null);
  const orderId = String(asRecord(first.body)['id']);
  const decrementCalls = harness.inventory.decrementCalls.length;

  const second = await harness.post('/orders', VALID_BODY, { 'Idempotency-Key': key });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.headers.get('x-idempotent-replay'), 'true');
  assert.deepEqual(second.body, first.body, 'the replay must return the order created by the first request');
  assert.equal(String(asRecord(second.body)['id']), orderId);

  // A replay of the same key with a different payload is still the same creation intent.
  const third = await harness.post(
    '/orders',
    { productId: 'product-b', quantity: 9, customerEmail: 'someone@example.com' },
    { 'Idempotency-Key': key },
  );
  assert.equal(third.status, 200);
  assert.equal(third.headers.get('x-idempotent-replay'), 'true');
  assert.deepEqual(third.body, first.body);

  assert.equal(harness.inventory.decrementCalls.length, decrementCalls, 'no second decrement may be attempted');
  assert.equal(harness.store.operations.size, 1, 'exactly one saga row may exist for the key');
  assert.equal(harness.store.orders.size, 1);
  assert.equal(harness.store.outbox.size, 1);
  assert.equal(harness.notifications.dispatches.length, 1, 'exactly one confirmation may be dispatched');

  // Without the header the behaviour is exactly the legacy one: every request creates an order.
  const legacyFirst = await harness.post('/orders', VALID_BODY);
  const legacySecond = await harness.post('/orders', VALID_BODY);
  assert.equal(legacyFirst.status, 201);
  assert.equal(legacySecond.status, 201);
  assert.notEqual(
    asRecord(legacyFirst.body)['id'],
    asRecord(legacySecond.body)['id'],
    'without the header two requests create two orders (legacy behaviour)',
  );
  assert.equal(harness.store.orders.size, 3);
  assert.equal(harness.store.operations.size, 3);
});

test('ORD-U7 an unanswerable inventory decrement answers 503 UNAVAILABLE after the bounded inline attempts and leaves UNCERTAIN', async (t) => {
  const harness = await startUnitHarness({ config: { inlineCallAttempts: 2 } });
  t.after(() => harness.close());

  harness.inventory.setDecrementHandler(() => ({ kind: 'UNAVAILABLE', detail: 'The operation was aborted' }));

  const response = await harness.post('/orders', VALID_BODY);

  assert.equal(response.status, 503);
  assert.deepEqual(asRecord(response.body), UNAVAILABLE_ENVELOPE);
  assert.equal(
    harness.inventory.decrementCalls.length,
    2,
    'exactly INLINE_CALL_ATTEMPTS calls may be made inside one request',
  );
  assert.equal(harness.store.orders.size, 0);
  assert.equal(harness.store.outbox.size, 0);

  const operation = [...harness.store.operations.values()][0];
  assert.ok(operation);
  assert.equal(operation.state, 'UNCERTAIN');
  assert.equal(operation.attempts, 2);
  assert.match(String(operation.lastError), /aborted/i);

  // Resume forward: once inventory answers, the recovery worker resolves the same saga row and the
  // recorded decrement is used, so the order appears exactly once and nothing is decremented twice.
  harness.inventory.setDecrementHandler(decreaseWith(1200, 7));
  await harness.recovery.recoverOnce();

  const completed = harness.store.operations.get(operation.orderId);
  assert.equal(completed?.state, 'COMPLETED');
  assert.equal(completed?.decrementOutcome, 'DECREMENTED');
  assert.equal(harness.store.orders.size, 1);
  assert.equal(harness.inventory.decrementCalls.length, 3);

  const persisted = harness.store.orders.get(operation.orderId);
  assert.equal(persisted?.totalCents, 3600);
  assert.equal(persisted?.status, 'CONFIRMED');
});

test('ORD-U9 the outbox marks a delivered confirmation DELIVERED and keeps a failed one PENDING with backoff', async (t) => {
  // A controllable clock so the exponential backoff can be asserted exactly.
  let clock = new Date('2026-01-01T00:00:00.000Z');
  const now = (): Date => new Date(clock.getTime());
  const harness = await startUnitHarness({ now });
  t.after(() => harness.close());

  const key = `ORD-U9-${randomUUID()}`;
  const delivered = await harness.post('/orders', VALID_BODY, { 'Idempotency-Key': key });
  assert.equal(delivered.status, 201);
  assert.match(String(asRecord(delivered.body)['id']), UUID_PATTERN);
  const deliveredEntry = harness.store.outbox.get(1);
  assert.equal(deliveredEntry?.state, 'DELIVERED');
  assert.equal(deliveredEntry?.attempts, 1);
  assert.equal(deliveredEntry?.lastError, null);
  assert.equal(harness.notifications.dispatches.length, 1);

  // Notifications unavailable: the order is committed, the caller sees 500 and the intent stays
  // PENDING with the failure recorded and a retry scheduled.
  harness.notifications.setHandler(() => ({
    delivered: false,
    error: 'the notifications service answered 502: {"error":"Notification provider unavailable"}',
  }));
  const failedKey = `ORD-U9-failed-${randomUUID()}`;
  const failed = await harness.post('/orders', VALID_BODY, { 'Idempotency-Key': failedKey });
  assert.equal(failed.status, 500);
  assert.deepEqual(asRecord(failed.body), INTERNAL_ENVELOPE, 'the documented 500 body carries error only');

  const failedOrderId = [...harness.store.operations.values()].find(
    (operation) => operation.clientIdempotencyKey === failedKey,
  )?.orderId;
  assert.ok(failedOrderId, 'the saga row carries the order id of the failed confirmation');
  const committed = harness.store.orders.get(failedOrderId);
  assert.ok(committed, 'the order must be committed even though the confirmation failed');
  assert.equal(committed.status, 'CONFIRMED');

  const pending = harness.store.outbox.get(2);
  assert.ok(pending);
  assert.equal(pending.state, 'PENDING');
  assert.equal(pending.attempts, 1);
  assert.match(String(pending.lastError), /502/);
  assert.equal(
    pending.nextAttemptAt.getTime() - clock.getTime(),
    CONFIG_DEFAULTS.outboxBackoffBaseMs,
    'the first retry is scheduled OUTBOX_BACKOFF_BASE_MS after the failure',
  );

  // The background dispatcher retries: the second failure doubles the backoff.
  clock = new Date(pending.nextAttemptAt.getTime());
  await harness.outbox.dispatchOrderConfirmation(failedOrderId);
  const retried = harness.store.outbox.get(2);
  assert.equal(retried?.state, 'PENDING');
  assert.equal(retried?.attempts, 2);
  assert.equal(
    (retried?.nextAttemptAt.getTime() ?? 0) - clock.getTime(),
    2 * CONFIG_DEFAULTS.outboxBackoffBaseMs,
    'bounded exponential backoff, factor 2',
  );

  // Once notifications answers, the same intent is delivered exactly once and the caller can replay
  // the key to learn that the order survived.
  harness.notifications.setHandler(() => ({ delivered: true }));
  clock = new Date(retried?.nextAttemptAt.getTime() ?? clock.getTime());
  assert.equal(await harness.outbox.dispatchDue(), 1, 'the dispatcher must pick the due row up');
  const finalEntry = harness.store.outbox.get(2);
  assert.equal(finalEntry?.state, 'DELIVERED');
  assert.equal(finalEntry?.attempts, 3);
  assert.equal(finalEntry?.lastError, null);
  assert.equal(
    harness.notifications.dispatches.filter((intent) => intent.orderId === failedOrderId).length,
    3,
    'three attempts: the inline one and two retries',
  );

  const replay = await harness.post('/orders', VALID_BODY, { 'Idempotency-Key': failedKey });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
  assert.equal(asRecord(replay.body)['id'], failedOrderId);
  assert.equal(harness.store.orders.size, 2);
  assert.equal(harness.store.outbox.size, 2, 'a replay must not create a second outbox row');
});
