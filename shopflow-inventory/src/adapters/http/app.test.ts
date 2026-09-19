import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { CatalogService } from '../../application/catalog-service.js';
import { StockService } from '../../application/stock-service.js';
import { createInventoryApplication } from '../../composition.js';
import { InMemoryInventory, SEEDED_PRODUCTS } from '../../test-support/in-memory-inventory.js';
import { jsonRequest, send, type TestResponse } from '../../test-support/http-client.js';
import { startTestServer, type TestServer } from '../../test-support/http-server.js';
import { createInventoryApp } from './app.js';

/**
 * `INV-U*` - the HTTP contract of `apis/inventory-service-api.md` version 1, without a database.
 *
 * Every test gets its own in-memory inventory and its own server, so the assertions about "what was
 * written" are exact. The same contract is asserted again against real PostgreSQL in
 * `src/adapters/postgres/inventory.integration.test.ts`.
 */

const ORDER_ONE = '6f1c1d38-6a1e-4f6f-9d3f-2d8a9f0f8c11';
const ORDER_TWO = '0f2e2c48-7b2f-4a70-8e40-3e9b0a1f9d22';
const UNKNOWN_ORDER = '00000000-0000-4000-8000-000000000000';

const INVALID_ENVELOPE = { error: 'A product id and a positive whole quantity are required', code: 'INVALID' };
const PRODUCT_NOT_FOUND_ENVELOPE = { error: 'Product not found', code: 'NOT_FOUND' };
const INSUFFICIENT_STOCK_ENVELOPE = { error: 'Insufficient stock', code: 'INSUFFICIENT_STOCK' };
const ALREADY_RELEASED_ENVELOPE = { error: 'The decrement for this order was already released', code: 'STATE_CONFLICT' };
const NO_DECREMENT_ENVELOPE = { error: 'No stock decrement recorded for this order', code: 'NOT_FOUND' };
const NOT_RELEASABLE_ENVELOPE = { error: 'Only a completed decrement can be released', code: 'STATE_CONFLICT' };

interface Harness {
  readonly url: string;
  readonly inventory: InMemoryInventory;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const inventory = new InMemoryInventory();
  const app = createInventoryApp({
    catalog: new CatalogService(inventory.catalog),
    stock: new StockService(inventory),
  });
  const server: TestServer = await startTestServer(app);
  return { url: server.url, inventory, close: () => server.close() };
}

function decrement(
  url: string,
  orderId: string,
  productId: string,
  quantity: unknown,
  key = orderId,
): Promise<TestResponse> {
  return send(
    url,
    '/stock-decrements',
    jsonRequest('POST', { orderId, productId, quantity }, { 'Idempotency-Key': key }),
  );
}

test('INV-U1 GET /products answers the seed ordered by id with exactly the five documented fields', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const response = await send(harness.url, '/products');

  assert.equal(response.status, 200);
  assert.match(String(response.headers.get('content-type')), /application\/json/);
  assert.deepEqual(response.body, SEEDED_PRODUCTS);
  for (const product of response.body) {
    assert.deepEqual(Object.keys(product).sort(), ['id', 'name', 'priceCents', 'sku', 'stock']);
  }
});

test('INV-U1 GET /products/:id answers the product and the documented 404 envelope', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const found = await send(harness.url, '/products/product-b');
  assert.equal(found.status, 200);
  assert.deepEqual(found.body, { id: 'product-b', sku: 'SKU-B', name: 'Product B', priceCents: 2500, stock: 5 });

  const missing = await send(harness.url, '/products/product-zzz');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, PRODUCT_NOT_FOUND_ENVELOPE);
  assert.deepEqual(Object.keys(missing.body as object).sort(), ['code', 'error']);
});

test('INV-U2 an over-large decrement answers 409 INSUFFICIENT_STOCK and changes no stock', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const response = await decrement(harness.url, ORDER_ONE, 'product-b', 6);

  assert.equal(response.status, 409);
  assert.deepEqual(response.body, INSUFFICIENT_STOCK_ENVELOPE);
  assert.deepEqual(Object.keys(response.body as object).sort(), ['code', 'error']);
  assert.equal(harness.inventory.stockOf('product-b'), 5);
  assert.equal(harness.inventory.stockUpdates, 0);
  assert.equal(harness.inventory.ledgerSize(), 1, 'the rejected outcome must be recorded for replay');

  const replay = await decrement(harness.url, ORDER_ONE, 'product-b', 6);
  assert.equal(replay.status, 409, 'the replay keeps the recorded status code');
  assert.deepEqual(replay.body, INSUFFICIENT_STOCK_ENVELOPE);
  assert.equal(harness.inventory.stockUpdates, 0);
});

test('INV-U3 POST /stock-decrements answers 201 and replays 200 with the recorded body', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const first = await decrement(harness.url, ORDER_ONE, 'product-a', 3);
  assert.equal(first.status, 201);
  assert.deepEqual(first.body, {
    orderId: ORDER_ONE,
    productId: 'product-a',
    quantity: 3,
    unitPriceCents: 1200,
    totalCents: 3600,
    remainingStock: 7,
    status: 'DECREMENTED',
  });
  assert.equal(first.headers.get('x-idempotent-replay'), null, 'a first execution is not a replay');

  const replay = await decrement(harness.url, ORDER_ONE, 'product-a', 3);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
  assert.deepEqual(replay.body, first.body);
  assert.equal(harness.inventory.stockOf('product-a'), 7);
  assert.equal(harness.inventory.stockUpdates, 1);
  assert.equal(harness.inventory.ledgerWrites, 1);
});

test('INV-U3 an unknown product answers 404 NOT_FOUND and is recorded and replayed', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const first = await decrement(harness.url, ORDER_TWO, 'product-unknown', 1);
  assert.equal(first.status, 404);
  assert.deepEqual(first.body, PRODUCT_NOT_FOUND_ENVELOPE);

  const replay = await decrement(harness.url, ORDER_TWO, 'product-unknown', 1);
  assert.equal(replay.status, 404);
  assert.deepEqual(replay.body, PRODUCT_NOT_FOUND_ENVELOPE);
  assert.equal(replay.headers.get('x-idempotent-replay'), null, 'the contract defines the replay header for the 200 replay only');
  assert.equal(harness.inventory.ledgerSize(), 1);
  assert.equal(harness.inventory.stockUpdates, 0);
});

test('INV-U4 the release endpoint restores stock once and replays the identical body', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const decrementResponse = await decrement(harness.url, ORDER_ONE, 'product-a', 3);
  assert.equal(decrementResponse.status, 201);

  const released = await send(harness.url, `/stock-decrements/${ORDER_ONE}/release`, { method: 'POST' });
  assert.equal(released.status, 200);
  assert.deepEqual(released.body, { orderId: ORDER_ONE, status: 'RELEASED', releasedQuantity: 3, remainingStock: 10 });
  assert.equal(harness.inventory.stockOf('product-a'), 10);

  const replayed = await send(harness.url, `/stock-decrements/${ORDER_ONE}/release`, { method: 'POST' });
  assert.equal(replayed.status, 200);
  assert.deepEqual(replayed.body, released.body);
  assert.equal(harness.inventory.stockOf('product-a'), 10, 'a repeated release must not increment again');
});

test('INV-U5 releasing a recorded rejection answers 409 STATE_CONFLICT', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  assert.equal((await decrement(harness.url, ORDER_ONE, 'product-b', 6)).status, 409);
  const response = await send(harness.url, `/stock-decrements/${ORDER_ONE}/release`, { method: 'POST' });

  assert.equal(response.status, 409);
  assert.deepEqual(response.body, NOT_RELEASABLE_ENVELOPE);
  assert.equal(harness.inventory.stockOf('product-b'), 5);
});

test('INV-U6 releasing an order id with no recorded decrement answers 404 NOT_FOUND', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  for (const orderId of [UNKNOWN_ORDER, 'not-a-uuid']) {
    const response = await send(harness.url, `/stock-decrements/${orderId}/release`, { method: 'POST' });
    assert.equal(response.status, 404, orderId);
    assert.deepEqual(response.body, NO_DECREMENT_ENVELOPE, orderId);
  }
  assert.equal(harness.inventory.ledgerSize(), 0);
  assert.equal(harness.inventory.ledgerWrites, 0);
});

test('INV-U7 a decrement for a released order answers 409 STATE_CONFLICT', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  assert.equal((await decrement(harness.url, ORDER_ONE, 'product-a', 4)).status, 201);
  assert.equal((await send(harness.url, `/stock-decrements/${ORDER_ONE}/release`, { method: 'POST' })).status, 200);

  const response = await decrement(harness.url, ORDER_ONE, 'product-a', 4);
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, ALREADY_RELEASED_ENVELOPE);
  assert.equal(harness.inventory.stockOf('product-a'), 10);
});

test('INV-U9 every malformed decrement request answers 400 INVALID and writes nothing', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const body = { orderId: ORDER_ONE, productId: 'product-a', quantity: 1 };
  const cases: Array<[string, RequestInit]> = [
    ['missing Idempotency-Key', jsonRequest('POST', body)],
    ['idempotency key differs from the body order id', jsonRequest('POST', body, { 'Idempotency-Key': ORDER_TWO })],
    ['order id is not a UUID', jsonRequest('POST', { ...body, orderId: 'order-1' }, { 'Idempotency-Key': 'order-1' })],
    ['product id is missing', jsonRequest('POST', { orderId: ORDER_ONE, quantity: 1 }, { 'Idempotency-Key': ORDER_ONE })],
    ['quantity is zero', jsonRequest('POST', { ...body, quantity: 0 }, { 'Idempotency-Key': ORDER_ONE })],
    ['quantity is negative', jsonRequest('POST', { ...body, quantity: -1 }, { 'Idempotency-Key': ORDER_ONE })],
    ['quantity is fractional', jsonRequest('POST', { ...body, quantity: 2.5 }, { 'Idempotency-Key': ORDER_ONE })],
    ['quantity is a string', jsonRequest('POST', { ...body, quantity: '1' }, { 'Idempotency-Key': ORDER_ONE })],
    ['body is missing', jsonRequest('POST', undefined, { 'Idempotency-Key': ORDER_ONE })],
  ];

  for (const [label, init] of cases) {
    const response = await send(harness.url, '/stock-decrements', init);
    assert.equal(response.status, 400, label);
    assert.deepEqual(response.body, INVALID_ENVELOPE, label);
  }

  const malformed = await send(harness.url, '/stock-decrements', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': ORDER_ONE },
    body: '{"orderId":',
  });
  assert.equal(malformed.status, 400, 'a malformed JSON body is INVALID as well');
  assert.deepEqual(malformed.body, INVALID_ENVELOPE);

  assert.equal(harness.inventory.ledgerSize(), 0, 'an INVALID request is never recorded');
  assert.equal(harness.inventory.stockUpdates, 0);
});

test('INV-U10 correlation ids are echoed, generated and never leak extra envelope fields', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const echoed = await send(harness.url, '/products/product-a', {
    headers: { 'x-correlation-id': 'correlation-from-the-caller' },
  });
  assert.equal(echoed.status, 200);
  assert.equal(echoed.headers.get('x-correlation-id'), 'correlation-from-the-caller');

  const generated = await send(harness.url, '/health');
  assert.equal(generated.status, 200);
  const correlation = generated.headers.get('x-correlation-id');
  assert.ok(correlation !== null && correlation.length > 0, 'a correlation id must be generated');

  const unknownRoute = await send(harness.url, '/orders');
  assert.equal(unknownRoute.status, 404);
  assert.deepEqual(unknownRoute.body, { error: 'Not found', code: 'NOT_FOUND' });
});

test('INV-U11 GET /health answers without a database round trip and driver failures answer the 500 envelope', async (t) => {
  const pool = new Pool({
    connectionString: 'postgres://inventory:inventory@127.0.0.1:1/inventory',
    connectionTimeoutMillis: 2000,
  });
  const server = await startTestServer(createInventoryApplication(pool));
  t.after(async () => {
    await server.close();
    await pool.end().catch(() => undefined);
  });

  const health = await send(server.url, '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true });
  assert.match(String(health.headers.get('content-type')), /application\/json/);

  const products = await send(server.url, '/products');
  assert.equal(products.status, 500);
  assert.deepEqual(products.body, { error: 'Internal server error' });

  const decrements = await decrement(server.url, ORDER_ONE, 'product-a', 1);
  assert.equal(decrements.status, 500);
  assert.deepEqual(decrements.body, { error: 'Internal server error' });
});
