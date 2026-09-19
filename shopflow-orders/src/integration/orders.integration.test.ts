/**
 * ORD-I* - the integration layer: the real orders application over a real PostgreSQL 17, the real
 * `shopflow-inventory` service, the real `shopflow-notifications` service and a stubbed provider,
 * with the two worker loops running on short intervals.
 *
 * Every stock assertion goes through the frozen inventory API (`GET /products`, the idempotent
 * replay of `POST /stock-decrements` and `POST /stock-decrements/:orderId/release`), every delivery
 * assertion goes through the notifications API (`GET /notifications`) and the provider stub; the
 * database queries of this file read this repository's own three tables only.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import {
  delay,
  startIntegrationEnvironment,
  unusedLoopbackUrl,
  type IntegrationEnvironment,
  type OrdersInstance,
} from '../test-support/integration-environment.js';
import { waitFor } from '../test-support/http-client.js';

const BUYER = 'buyer@example.com';

const INSUFFICIENT_STOCK_ENVELOPE = { error: 'Insufficient stock', code: 'INSUFFICIENT_STOCK' };
const INVALID_STATUS_ENVELOPE = { error: 'Only CONFIRMED orders can be shipped', code: 'INVALID_STATUS' };
const ORDER_NOT_FOUND_ENVELOPE = { error: 'Order not found', code: 'NOT_FOUND' };
const INTERNAL_ENVELOPE = { error: 'Internal server error' };
const UNAVAILABLE_ENVELOPE = { error: 'Upstream service unavailable', code: 'UNAVAILABLE' };

const RECOVERY_TIMEOUT_MS = 25_000;

type ProductView = {
  readonly id: string;
  readonly priceCents: number;
  readonly stock: number;
};

type SagaRow = {
  readonly order_id: string;
  readonly state: string;
  readonly decrement_outcome: string | null;
  readonly attempts: number;
  readonly last_error: string | null;
};

type OutboxRow = {
  readonly state: string;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly next_attempt_at: Date;
};

let environment: IntegrationEnvironment | undefined;
const instances: OrdersInstance[] = [];

before(async () => {
  environment = await startIntegrationEnvironment();
  console.log(`[integration] ${environment.description}`);
});

beforeEach(async () => {
  await env().resetAll();
  // A test may have stopped the provider; the environment is always handed over listening.
  await env().provider.start();
});

after(async () => {
  while (instances.length > 0) {
    await instances.pop()?.close();
  }
  await environment?.dispose();
  environment = undefined;
});

function env(): IntegrationEnvironment {
  assert.ok(environment, 'the integration environment is not running');
  return environment;
}

/** Starts an orders application instance and keeps it for teardown. */
async function startOrders(options: Parameters<IntegrationEnvironment['startOrdersInstance']>[0] = {}) {
  const instance = await env().startOrdersInstance(options);
  instances.push(instance);
  return instance;
}

function record(body: unknown): Record<string, unknown> {
  assert.equal(typeof body, 'object', `expected a JSON object, received ${JSON.stringify(body)}`);
  assert.notEqual(body, null);
  return body as Record<string, unknown>;
}

async function postJson(
  baseUrl: string,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload ?? {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text === '' ? undefined : (JSON.parse(text) as unknown),
  };
}

async function catalog(): Promise<ProductView[]> {
  const response = await fetch(`${env().inventoryUrl}/products`);
  assert.equal(response.status, 200, 'the inventory service must list its catalog');
  return (await response.json()) as ProductView[];
}

function stockIn(catalog: ProductView[], productId: string): number {
  const product = catalog.find((candidate) => candidate.id === productId);
  assert.ok(product, `product ${productId} must exist`);
  return product.stock;
}

async function stock(productId: string): Promise<number> {
  return stockIn(await catalog(), productId);
}

async function notificationRecords(): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${env().notificationsUrl}/notifications`);
  assert.equal(response.status, 200, 'the notifications service must list its records');
  return (await response.json()) as Record<string, unknown>[];
}

async function notificationsForOrder(orderId: string): Promise<Record<string, unknown>[]> {
  return (await notificationRecords()).filter((entry) => entry['orderId'] === orderId);
}

async function sagaByClientKey(key: string): Promise<SagaRow> {
  const rows = await env().queryOwnDatabase<SagaRow>(
    'SELECT order_id, state, decrement_outcome, attempts, last_error FROM order_operations WHERE client_idempotency_key = $1',
    [key],
  );
  assert.equal(rows.length, 1, `exactly one saga row for client key ${key}`);
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function sagaByOrderId(orderId: string): Promise<SagaRow> {
  const rows = await env().queryOwnDatabase<SagaRow>(
    'SELECT order_id, state, decrement_outcome, attempts, last_error FROM order_operations WHERE order_id = $1',
    [orderId],
  );
  assert.equal(rows.length, 1, `exactly one saga row for order ${orderId}`);
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function outboxForOrder(orderId: string): Promise<OutboxRow | null> {
  const rows = await env().queryOwnDatabase<OutboxRow>(
    'SELECT state, attempts, last_error, next_attempt_at FROM notification_outbox WHERE order_id = $1',
    [orderId],
  );
  return rows[0] ?? null;
}

async function countOrders(): Promise<number> {
  const rows = await env().queryOwnDatabase<{ id: string }>('SELECT id FROM orders');
  return rows.length;
}

/** The frozen inventory interface: repeating a recorded order id replays it, it never decrements twice. */
async function replayDecrement(orderId: string, productId: string, quantity: number) {
  return postJson(
    env().inventoryUrl,
    '/stock-decrements',
    { orderId, productId, quantity },
    { 'Idempotency-Key': orderId },
  );
}

async function releaseDecrement(orderId: string) {
  return postJson(env().inventoryUrl, `/stock-decrements/${encodeURIComponent(orderId)}/release`, {});
}

async function waitForNotification(orderId: string, status: string): Promise<Record<string, unknown>> {
  return waitFor(
    async () => {
      const records = await notificationsForOrder(orderId);
      return records.length === 1 && records[0]?.['status'] === status ? records[0] : undefined;
    },
    { timeoutMs: RECOVERY_TIMEOUT_MS, intervalMs: 200, description: `the notification of ${orderId} to reach ${status}` },
  );
}

async function waitForSaga(orderId: string, state: string): Promise<Record<string, unknown>> {
  return waitFor(
    async () => {
      const response = await (instances[instances.length - 1] as OrdersInstance).get(
        `/orders/${orderId}/operations`,
      );
      const body = response.body === undefined ? {} : record(response.body);
      return body['state'] === state ? body : undefined;
    },
    { timeoutMs: RECOVERY_TIMEOUT_MS, intervalMs: 200, description: `the saga of ${orderId} to reach ${state}` },
  );
}

// ---------------------------------------------------------------------------------------------

test('ORD-I1 order creation end to end: order persisted, stock reduced exactly once, one DELIVERED outbox row', async (t) => {
  const orders = await startOrders();

  const created = await orders.post('/orders', { productId: 'product-a', quantity: 3, customerEmail: BUYER });
  assert.equal(created.status, 201, created.text);
  const order = record(created.body);
  assert.equal(order['status'], 'CONFIRMED');
  assert.equal(order['customerEmail'], BUYER);
  assert.equal(order['productId'], 'product-a');
  assert.equal(order['quantity'], 3);
  assert.equal(order['totalCents'], 3600, 'the total is the inventory price snapshot times the quantity');
  const orderId = String(order['id']);

  // The order row is persisted in the service's own database.
  const rows = await env().queryOwnDatabase<{ id: string; status: string; total_cents: number; quantity: number }>(
    'SELECT id, status, total_cents, quantity FROM orders',
  );
  assert.deepEqual(rows.map((row) => row.id), [orderId]);
  assert.equal(rows[0]?.status, 'CONFIRMED');
  assert.equal(rows[0]?.total_cents, 3600);

  // Exactly one decrement of 3 through the inventory API: 10 -> 7, and the replay of the same ledger
  // key returns the recorded outcome without touching stock again.
  assert.equal(await stock('product-a'), 7);
  const replay = await replayDecrement(orderId, 'product-a', 3);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
  assert.equal(record(replay.body)['remainingStock'], 7);
  assert.equal(await stock('product-a'), 7, 'a replay must not decrement a second time');

  // The saga reached COMPLETED and the durable outbox row is DELIVERED.
  const operations = record((await orders.get(`/orders/${orderId}/operations`)).body);
  assert.equal(operations['state'], 'COMPLETED');
  assert.equal(operations['decrementOutcome'], 'DECREMENTED');
  assert.equal(operations['notificationOutboxState'], 'DELIVERED');
  assert.equal(operations['attempts'], 1);
  assert.equal(operations['quantity'], 3);

  const outbox = await outboxForOrder(orderId);
  assert.equal(outbox?.state, 'DELIVERED');
  assert.equal(outbox?.attempts, 1);
  assert.equal(outbox?.last_error, null);

  // Exactly one confirmation, verified through the notifications API and the provider.
  const delivered = await waitForNotification(orderId, 'DELIVERED');
  assert.equal(delivered['type'], 'ORDER_CONFIRMATION');
  assert.equal(delivered['customerEmail'], BUYER);
  assert.equal((await notificationsForOrder(orderId)).length, 1);
  assert.equal(env().provider.recordsForOrder(orderId).length, 1);

  t.diagnostic(
    `ORD-I1 POST /orders -> 201 ${JSON.stringify(order)}; product-a stock 10 -> 7; outbox ${String(outbox?.state)}; ` +
      `notifications ${JSON.stringify((await notificationsForOrder(orderId))[0])}`,
  );
  t.diagnostic(`ORD-I1 provider records: ${JSON.stringify(env().provider.recordsForOrder(orderId))}`);
});

test('ORD-I2 the SHIPPED transition persists, is not repeatable and concurrent ship calls yield exactly one SHIPPED', async (t) => {
  const orders = await startOrders({ workers: false });

  const created = await orders.post('/orders', { productId: 'product-a', quantity: 1, customerEmail: BUYER });
  assert.equal(created.status, 201, created.text);
  const orderId = String(record(created.body)['id']);
  assert.equal(await stock('product-a'), 9);

  const shipCalls = await Promise.all(
    Array.from({ length: 5 }, () => orders.post(`/orders/${orderId}/ship`, {})),
  );
  const shipped = shipCalls.filter((response) => response.status === 200);
  const conflicts = shipCalls.filter((response) => response.status === 409);
  assert.equal(shipped.length, 1, 'exactly one concurrent ship call may win');
  assert.equal(conflicts.length, 4);
  for (const conflict of conflicts) {
    assert.deepEqual(conflict.body, INVALID_STATUS_ENVELOPE);
  }
  assert.equal(record(shipped[0]?.body)['status'], 'SHIPPED');

  // Persisted, and the single conditional statement is the serialization point.
  const rows = await env().queryOwnDatabase<{ status: string }>('SELECT status FROM orders');
  assert.deepEqual(rows.map((row) => row.status), ['SHIPPED']);

  const detail = await orders.get(`/orders/${orderId}`);
  assert.equal(detail.status, 200);
  assert.equal(record(detail.body)['status'], 'SHIPPED');

  const repeated = await orders.post(`/orders/${orderId}/ship`, {});
  assert.equal(repeated.status, 409);
  assert.deepEqual(repeated.body, INVALID_STATUS_ENVELOPE);

  const unknown = await orders.post(`/orders/${randomUUID()}/ship`, {});
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, ORDER_NOT_FOUND_ENVELOPE);

  // Shipping never touches inventory or notifications.
  assert.equal(await stock('product-a'), 9);
  assert.equal(env().provider.recordsForOrder(orderId).length, 1, 'only the creation confirmation exists');
  assert.equal((await notificationsForOrder(orderId)).length, 1);

  t.diagnostic(`ORD-I2 5 concurrent ship calls -> ${shipCalls.map((call) => call.status).join(', ')}`);
});

test('ORD-I3 restart recovery resolves a crashed saga exactly once, and a second restart changes nothing', async (t) => {
  // ---- crash window 1: the inventory service is not reachable, so the decrement outcome is unknown.
  const key = `ORD-I3-${Date.now().toString(36)}`;
  const unreachableInventory = await unusedLoopbackUrl();
  const first = await startOrders({ workers: false, config: { inventoryUrl: unreachableInventory } });

  const ambiguous = await first.post(
    '/orders',
    { productId: 'product-a', quantity: 4, customerEmail: BUYER },
    { 'Idempotency-Key': key },
  );
  assert.equal(ambiguous.status, 503, ambiguous.text);
  assert.deepEqual(ambiguous.body, UNAVAILABLE_ENVELOPE);

  const crashed = await sagaByClientKey(key);
  const orderId = crashed.order_id;
  assert.equal(crashed.state, 'UNCERTAIN', 'the unanswerable decrement leaves the saga UNCERTAIN');
  assert.equal(await countOrders(), 0);
  assert.equal(await stock('product-a'), 10, 'nothing was decremented while inventory was unreachable');

  // The "process" is gone; only the persisted saga remains.
  await first.close();

  const second = await startOrders();
  const resolved = await waitForSaga(orderId, 'COMPLETED');
  assert.equal(resolved['decrementOutcome'], 'DECREMENTED');
  assert.equal(resolved['quantity'], 4);
  assert.equal(resolved['orderId'], orderId);

  await waitForNotification(orderId, 'DELIVERED');
  assert.equal(await stock('product-a'), 6, 'the recovery applied exactly one decrement of 4');
  assert.equal(await countOrders(), 1, 'exactly one order exists for the recovered saga');
  assert.equal((await outboxForOrder(orderId))?.state, 'DELIVERED');
  assert.equal(env().provider.recordsForOrder(orderId).length, 1);

  // The ledger still holds exactly one decrement: replaying it does not change the stock.
  const replay = await replayDecrement(orderId, 'product-a', 4);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
  assert.equal(record(replay.body)['remainingStock'], 6);
  assert.equal(await stock('product-a'), 6);

  // A second restart is idempotent: nothing is decremented, created or delivered again.
  await second.close();
  const third = await startOrders();
  await delay(1000);
  assert.equal(await stock('product-a'), 6);
  assert.equal(await countOrders(), 1);
  assert.equal((await notificationsForOrder(orderId)).length, 1);
  assert.equal(env().provider.recordsForOrder(orderId).length, 1);
  assert.equal((await sagaByOrderId(orderId)).state, 'COMPLETED');

  const replayedCreation = await third.post(
    '/orders',
    { productId: 'product-a', quantity: 4, customerEmail: BUYER },
    { 'Idempotency-Key': key },
  );
  assert.equal(replayedCreation.status, 200, replayedCreation.text);
  assert.equal(replayedCreation.headers.get('x-idempotent-replay'), 'true');
  assert.equal(record(replayedCreation.body)['id'], orderId);

  t.diagnostic(
    `ORD-I3 (UNCERTAIN) saga ${orderId}: ${crashed.state} -> ${String(resolved['state'])}; product-a stock ` +
      `10 -> ${await stock('product-a')}; order rows ${await countOrders()}; provider records ` +
      `${env().provider.recordsForOrder(orderId).length}`,
  );

  // ---- crash window 2: the process died after the saga row was committed but before the decrement.
  await env().resetAll();
  const orphanOrderId = randomUUID();
  const orphanKey = `ORD-I3-started-${Date.now().toString(36)}`;
  await env().queryOwnDatabase(
    `INSERT INTO order_operations
       (order_id, state, product_id, quantity, customer_email, client_idempotency_key, attempts, created_at, updated_at)
     VALUES ($1, 'STARTED', 'product-a', 2, $2, $3, 0, now() - interval '5 minutes', now() - interval '5 minutes')`,
    [orphanOrderId, BUYER, orphanKey],
  );

  const recovering = await startOrders();
  const startedResolved = await waitForSaga(orphanOrderId, 'COMPLETED');
  assert.equal(startedResolved['decrementOutcome'], 'DECREMENTED');
  assert.equal(await stock('product-a'), 8, 'the STARTED saga was replayed and applied exactly once');
  assert.equal(await countOrders(), 1);
  const orphanOrder = await env().queryOwnDatabase<{ id: string; status: string; total_cents: number }>(
    'SELECT id, status, total_cents FROM orders WHERE id = $1',
    [orphanOrderId],
  );
  assert.equal(orphanOrder[0]?.status, 'CONFIRMED');
  assert.equal(orphanOrder[0]?.total_cents, 2400);
  assert.equal((await outboxForOrder(orphanOrderId))?.state, 'DELIVERED');
  assert.equal(env().provider.recordsForOrder(orphanOrderId).length, 1);
  await waitForNotification(orphanOrderId, 'DELIVERED');
  void recovering;

  t.diagnostic(
    `ORD-I3 (STARTED) saga ${orphanOrderId}: STARTED -> COMPLETED; product-a stock 10 -> ${await stock('product-a')}; ` +
      `order rows ${await countOrders()}`,
  );
});

test('ORD-I4 a failed confirmation is retried from the outbox and delivered exactly once', async (t) => {
  await env().provider.stopListening();
  t.after(() => env().provider.start());

  const orders = await startOrders();
  const key = `ORD-I4-${Date.now().toString(36)}`;
  const payload = { productId: 'product-a', quantity: 2, customerEmail: BUYER };

  const failed = await orders.post('/orders', payload, { 'Idempotency-Key': key });
  assert.equal(failed.status, 500, failed.text);
  assert.deepEqual(failed.body, INTERNAL_ENVELOPE);

  const saga = await sagaByClientKey(key);
  const orderId = saga.order_id;

  // The order is committed and the stock is decremented: exactly the legacy behaviour, with a
  // durable intent instead of a lost confirmation.
  assert.equal(saga.state, 'COMPLETED');
  const committed = await env().queryOwnDatabase<{ status: string }>('SELECT status FROM orders WHERE id = $1', [
    orderId,
  ]);
  assert.deepEqual(committed.map((row) => row.status), ['CONFIRMED']);
  assert.equal(await stock('product-a'), 8);

  const pendingOutbox = await outboxForOrder(orderId);
  assert.equal(pendingOutbox?.state, 'PENDING');
  assert.ok((pendingOutbox?.attempts ?? 0) >= 1);
  assert.match(String(pendingOutbox?.last_error), /502/);
  assert.ok(
    (pendingOutbox?.next_attempt_at.getTime() ?? 0) > Date.now() - 60_000,
    'a retry must be scheduled',
  );

  // The notifications service persisted the intent before calling the provider, so its record is PENDING.
  assert.equal((await notificationsForOrder(orderId))[0]?.['status'], 'PENDING');
  assert.equal(env().provider.recordsForOrder(orderId).length, 0);

  // The provider returns: the confirmation is delivered exactly once.
  await env().provider.start();
  const delivered = await waitForNotification(orderId, 'DELIVERED');
  assert.equal(delivered['providerRecordId'] !== null, true);

  await waitFor(
    async () => ((await outboxForOrder(orderId))?.state === 'DELIVERED' ? true : undefined),
    { timeoutMs: RECOVERY_TIMEOUT_MS, intervalMs: 200, description: `the outbox row of ${orderId} to be DELIVERED` },
  );
  assert.equal((await notificationsForOrder(orderId)).length, 1, 'exactly one notification record');
  assert.equal(env().provider.recordsForOrder(orderId).length, 1, 'exactly one provider message');

  // The caller replays the creation key and learns that the order survived the failed confirmation.
  const replay = await orders.post('/orders', payload, { 'Idempotency-Key': key });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
  assert.equal(record(replay.body)['id'], orderId);
  assert.equal(record(replay.body)['status'], 'CONFIRMED');
  assert.equal(env().provider.recordsForOrder(orderId).length, 1, 'the replay must not deliver again');

  t.diagnostic(
    `ORD-I4 provider down -> 500 with the order committed (stock 10 -> 8, outbox ${String(pendingOutbox?.state)}); ` +
      `provider back -> ${JSON.stringify(delivered)}`,
  );
});

test('ORD-I5 two concurrent orders for the last units produce exactly one order and never negative stock', async (t) => {
  const orders = await startOrders();

  // product-b is seeded with 5 units; two orders of 4 race for them.
  const payload = { productId: 'product-b', quantity: 4, customerEmail: BUYER };
  const [left, right] = await Promise.all([orders.post('/orders', payload), orders.post('/orders', payload)]);

  const statuses = [left.status, right.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [201, 400], `one order must win (${left.text} | ${right.text})`);
  const rejected = left.status === 400 ? left : right;
  assert.deepEqual(rejected.body, INSUFFICIENT_STOCK_ENVELOPE);
  const accepted = left.status === 201 ? left : right;
  const orderId = String(record(accepted.body)['id']);
  assert.equal(record(accepted.body)['totalCents'], 10000);

  assert.equal(await stock('product-b'), 1, 'the stock is never negative and never oversold');
  assert.equal(await countOrders(), 1, 'the rejected creation must not create an order row');
  assert.deepEqual(
    (await env().queryOwnDatabase<{ state: string }>('SELECT state FROM order_operations ORDER BY order_id')).map(
      (row) => row.state,
    ).sort(),
    ['ABORTED_INSUFFICIENT_STOCK', 'COMPLETED'],
  );

  await waitForNotification(orderId, 'DELIVERED');
  assert.equal(env().provider.recordsForOrder(orderId).length, 1);

  // Exactly one decrement of 4 was recorded for the winning order id.
  const replay = await replayDecrement(orderId, 'product-b', 4);
  assert.equal(replay.status, 200);
  assert.equal(record(replay.body)['remainingStock'], 1);
  assert.equal(await stock('product-b'), 1);

  t.diagnostic(
    `ORD-I5 concurrent creations -> ${left.status}, ${right.status}; product-b stock 5 -> ${await stock('product-b')}`,
  );
});

test('ORD-I6 a local commit failure releases the confirmed decrement exactly once and never creates an order', async (t) => {
  const orders = await startOrders();
  const key = `ORD-I6-${Date.now().toString(36)}`;
  const payload = { productId: 'product-a', quantity: 3, customerEmail: BUYER };

  // Make the local transaction of step 8 fail for one request: PostgreSQL enforces a NOT VALID check
  // constraint on every new row, so the INSERT INTO orders of the order row cannot commit.
  await env().queryOwnDatabase('ALTER TABLE orders ADD CONSTRAINT orders_block_insert CHECK (false) NOT VALID');
  let response: Awaited<ReturnType<OrdersInstance['post']>>;
  try {
    response = await orders.post('/orders', payload, { 'Idempotency-Key': key });
  } finally {
    await env().queryOwnDatabase('ALTER TABLE orders DROP CONSTRAINT orders_block_insert');
  }

  assert.equal(response.status, 500, response.text);
  assert.deepEqual(response.body, INTERNAL_ENVELOPE);

  const saga = await sagaByClientKey(key);
  const orderId = saga.order_id;

  // The compensation restored the stock exactly once: the product is back to its original value.
  assert.equal(await stock('product-a'), 10, 'the compensating release restored the stock');
  const release = await releaseDecrement(orderId);
  assert.equal(release.status, 200);
  const released = record(release.body);
  assert.equal(released['status'], 'RELEASED');
  assert.equal(released['releasedQuantity'], 3);
  assert.equal(released['remainingStock'], 10);
  assert.equal(await stock('product-a'), 10, 'a repeated release must not increment again');

  // The inventory ledger of the order id is terminal: it can never become a decrement again.
  const decrementReplay = await replayDecrement(orderId, 'product-a', 3);
  assert.equal(decrementReplay.status, 409);
  assert.equal(record(decrementReplay.body)['code'], 'STATE_CONFLICT');

  // No order, no confirmation, and the saga records the compensation.
  assert.equal(await countOrders(), 0);
  assert.equal(await outboxForOrder(orderId), null);
  assert.equal(env().provider.recordsForOrder(orderId).length, 0);
  assert.equal(saga.state, 'DECREMENTED');
  assert.equal(saga.decrement_outcome, 'RELEASED');
  assert.match(String(saga.last_error), /local commit failed/);

  const operations = record((await orders.get(`/orders/${orderId}/operations`)).body);
  assert.equal(operations['state'], 'DECREMENTED');
  assert.equal(operations['decrementOutcome'], 'RELEASED');

  // The recovery worker never completes a released saga forward.
  await delay(1000);
  assert.equal(await countOrders(), 0);
  assert.equal(await stock('product-a'), 10);
  assert.equal(await outboxForOrder(orderId), null);
  assert.equal(env().provider.recordsForOrder(orderId).length, 0);

  t.diagnostic(
    `ORD-I6 local commit failure -> 500; saga ${orderId} ${saga.state}/${String(saga.decrement_outcome)}; ` +
      `product-a stock restored to ${await stock('product-a')}; release replay ${JSON.stringify(released)}`,
  );
});

test('ORD-I7 two concurrent requests with one client Idempotency-Key create exactly one order and one decrement', async (t) => {
  const orders = await startOrders();
  const key = `ORD-I7-${Date.now().toString(36)}`;
  const payload = { productId: 'product-a', quantity: 3, customerEmail: BUYER };

  const [left, right] = await Promise.all([
    orders.post('/orders', payload, { 'Idempotency-Key': key }),
    orders.post('/orders', payload, { 'Idempotency-Key': key }),
  ]);

  for (const response of [left, right]) {
    assert.ok(
      response.status === 200 || response.status === 201,
      `a concurrent duplicate must answer 200 or 201 (received ${response.status}: ${response.text})`,
    );
  }
  const orderId = String(record(left.body)['id']);
  assert.equal(record(right.body)['id'], orderId, 'both requests must resolve the same order');

  assert.equal(await countOrders(), 1);
  assert.equal(await stock('product-a'), 7, 'exactly one decrement of 3');
  assert.equal((await env().queryOwnDatabase<{ order_id: string }>('SELECT order_id FROM order_operations')).length, 1);
  assert.equal((await env().queryOwnDatabase<{ id: string }>('SELECT id FROM notification_outbox')).length, 1);

  await waitForNotification(orderId, 'DELIVERED');
  assert.equal(env().provider.recordsForOrder(orderId).length, 1, 'exactly one confirmation');

  t.diagnostic(`ORD-I7 concurrent duplicates -> ${left.status}, ${right.status} for the same order ${orderId}`);
});
