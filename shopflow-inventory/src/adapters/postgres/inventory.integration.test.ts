import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { createInventoryApplication } from '../../composition.js';
import { jsonRequest, send, type TestResponse } from '../../test-support/http-client.js';
import { startTestServer, type TestServer } from '../../test-support/http-server.js';
import {
  describeDatabaseUrl,
  integrationSkipReason,
  probeTestDatabase,
  resetInventoryDatabase,
  testDatabaseUrl,
} from '../../test-support/postgres-test-database.js';

/**
 * `INV-I*` - the same contract as the unit tests, but against a real PostgreSQL 17 database and the
 * real `pg` adapters, through the production composition root (`createInventoryApplication`).
 *
 * The connection string is `INVENTORY_DATABASE_URL` (or its documented local default); every test
 * starts by re-applying the authoritative `schema/inventory-schema.sql` to a real database, so the
 * deterministic seed and the DDL are exercised for real. When no database is reachable the tests are
 * reported as skipped with the exact reason instead of silently passing.
 */

const probe = await probeTestDatabase(testDatabaseUrl());
const skip = integrationSkipReason(probe);

const INVALID_ENVELOPE = { error: 'A product id and a positive whole quantity are required', code: 'INVALID' };
const PRODUCT_NOT_FOUND_ENVELOPE = { error: 'Product not found', code: 'NOT_FOUND' };
const INSUFFICIENT_STOCK_ENVELOPE = { error: 'Insufficient stock', code: 'INSUFFICIENT_STOCK' };
const NO_DECREMENT_ENVELOPE = { error: 'No stock decrement recorded for this order', code: 'NOT_FOUND' };

const SEEDED_CATALOG = [
  { id: 'product-a', sku: 'SKU-A', name: 'Product A', priceCents: 1200, stock: 10 },
  { id: 'product-b', sku: 'SKU-B', name: 'Product B', priceCents: 2500, stock: 5 },
];

interface LedgerRow {
  order_id: string;
  product_id: string;
  quantity: number;
  outcome: string;
  state: string;
  unit_price_cents: number | null;
  total_cents: number | null;
  remaining_stock: number | null;
}

let pool: Pool | undefined;
let server: TestServer | undefined;
let baseUrl = '';

before(async () => {
  if (skip !== false) {
    return;
  }
  const databasePool = new Pool({ connectionString: probe.url });
  pool = databasePool;
  await resetInventoryDatabase(databasePool);
  server = await startTestServer(createInventoryApplication(databasePool));
  baseUrl = server.url;
});

after(async () => {
  await server?.close();
  await pool?.end();
});

/** The integration database pool; every test is skipped when it could not be created. */
function database(): Pool {
  if (pool === undefined) {
    throw new Error('the integration database is not available');
  }
  return pool;
}

function decrement(orderId: string, productId: string, quantity: number, key = orderId): Promise<TestResponse> {
  return send(
    baseUrl,
    '/stock-decrements',
    jsonRequest('POST', { orderId, productId, quantity }, { 'Idempotency-Key': key }),
  );
}

function release(orderId: string): Promise<TestResponse> {
  return send(baseUrl, `/stock-decrements/${orderId}/release`, { method: 'POST' });
}

async function readStock(productId: string): Promise<number> {
  const result = await database().query<{ id: string; stock: number }>('SELECT id, stock FROM products WHERE id = $1', [
    productId,
  ]);
  const row = result.rows[0];
  assert.ok(row !== undefined, `product ${productId} must exist`);
  return row.stock;
}

async function readLedger(orderId: string): Promise<LedgerRow | undefined> {
  const result = await database().query<LedgerRow>(
    `SELECT order_id, product_id, quantity, outcome, state, unit_price_cents, total_cents, remaining_stock
       FROM stock_decrements WHERE order_id = $1`,
    [orderId],
  );
  return result.rows[0];
}

async function countLedgerRows(): Promise<number> {
  const result = await database().query<{ count: string }>('SELECT count(*) AS count FROM stock_decrements');
  return Number(result.rows[0]?.count ?? Number.NaN);
}

/** Sum of the quantities of every recorded `DECREMENTED` outcome for one product. */
async function appliedDecrementTotal(productId: string): Promise<number> {
  const result = await database().query<{ total: number }>(
    `SELECT COALESCE(SUM(quantity), 0)::int AS total
       FROM stock_decrements WHERE product_id = $1 AND outcome = 'DECREMENTED'`,
    [productId],
  );
  return result.rows[0]?.total ?? 0;
}

test('INV-I1 a decrement of 3 from product-a returns totalCents 3600, remainingStock 7 and persists it', { skip }, async (t) => {
  await resetInventoryDatabase(database());
  const orderId = randomUUID();

  const response = await decrement(orderId, 'product-a', 3);

  assert.equal(response.status, 201);
  assert.deepEqual(response.body, {
    orderId,
    productId: 'product-a',
    quantity: 3,
    unitPriceCents: 1200,
    totalCents: 3600,
    remainingStock: 7,
    status: 'DECREMENTED',
  });
  assert.equal(await readStock('product-a'), 7, 'the conditional update must have been committed');
  const ledger = await readLedger(orderId);
  assert.ok(ledger !== undefined);
  assert.equal(ledger.outcome, 'DECREMENTED');
  assert.equal(ledger.state, 'RECORDED');
  assert.equal(ledger.product_id, 'product-a');
  assert.equal(ledger.quantity, 3);
  assert.equal(ledger.unit_price_cents, 1200);
  assert.equal(ledger.total_cents, 3600);
  assert.equal(ledger.remaining_stock, 7);
  t.diagnostic(`INV-I1 product-a stock after the decrement: ${await readStock('product-a')}`);
});

test('INV-I2 five calls with the same orderId change stock exactly once and replay the recorded body', { skip }, async (t) => {
  await resetInventoryDatabase(database());
  const orderId = randomUUID();

  const first = await decrement(orderId, 'product-a', 3);
  assert.equal(first.status, 201);
  assert.equal(first.headers.get('x-idempotent-replay'), null);

  for (let call = 2; call <= 5; call += 1) {
    const replay = await decrement(orderId, 'product-a', 3);
    assert.equal(replay.status, 200, `call ${call} must replay`);
    assert.equal(replay.headers.get('x-idempotent-replay'), 'true', `call ${call} must be marked as a replay`);
    assert.deepEqual(replay.body, first.body, `call ${call} must return the recorded body`);
  }

  assert.equal(await readStock('product-a'), 7, 'exactly one decrement of 3 must be applied');
  assert.equal(await countLedgerRows(), 1, 'exactly one ledger row may exist for the order id');
  assert.equal(await appliedDecrementTotal('product-a'), 3);
  t.diagnostic(`INV-I2 five calls, stock 10 -> ${await readStock('product-a')}, ledger rows ${await countLedgerRows()}`);
});

test('INV-I3 releasing a decrement restores the stock exactly once and is idempotent', { skip }, async (t) => {
  await resetInventoryDatabase(database());
  const orderId = randomUUID();

  assert.equal((await decrement(orderId, 'product-a', 3)).status, 201);
  assert.equal(await readStock('product-a'), 7);

  const released = await release(orderId);
  assert.equal(released.status, 200);
  assert.deepEqual(released.body, { orderId, status: 'RELEASED', releasedQuantity: 3, remainingStock: 10 });
  assert.equal(await readStock('product-a'), 10, 'the release must restore the original stock');
  assert.equal((await readLedger(orderId))?.state, 'RELEASED');

  const replayed = await release(orderId);
  assert.equal(replayed.status, 200);
  assert.deepEqual(replayed.body, released.body);
  assert.equal(await readStock('product-a'), 10, 'a repeated release must not increment again');
  assert.equal(await countLedgerRows(), 1);
  t.diagnostic(`INV-I3 release applied twice, stock ${await readStock('product-a')}`);
});

test('INV-I4 concurrent decrements beyond the stock never oversell and sum to the stock delta', { skip }, async (t) => {
  await resetInventoryDatabase(database());

  // Two different orders, 4 + 4 against a stock of 5: exactly one may win.
  const [first, second] = await Promise.all([
    decrement(randomUUID(), 'product-b', 4),
    decrement(randomUUID(), 'product-b', 4),
  ]);
  const succeeded = [first, second].filter((response) => response.status === 201);
  const rejected = [first, second].filter((response) => response.status === 409);
  assert.equal(succeeded.length, 1, 'exactly one of the two competing decrements may succeed');
  assert.equal(rejected.length, 1);
  assert.deepEqual(rejected[0]?.body, INSUFFICIENT_STOCK_ENVELOPE);

  const stockAfterRace = await readStock('product-b');
  assert.ok(stockAfterRace >= 0, 'the CHECK (stock >= 0) invariant must hold');
  assert.equal(stockAfterRace, 1);
  assert.equal(await appliedDecrementTotal('product-b'), 5 - stockAfterRace, 'applied decrements must equal the delta');

  // Six concurrent decrements of 2 against the seeded product-a stock of 10: five may win.
  await resetInventoryDatabase(database());
  const responses = await Promise.all(
    Array.from({ length: 6 }, () => decrement(randomUUID(), 'product-a', 2)),
  );
  const applied = responses.filter((response) => response.status === 201);
  const refused = responses.filter(
    (response) => (response.body as { code?: string } | undefined)?.code === 'INSUFFICIENT_STOCK',
  );
  assert.equal(applied.length, 5, 'exactly five decrements of 2 fit into a stock of 10');
  assert.equal(refused.length, 1);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [201, 201, 201, 201, 201, 409],
    'every call must be either an applied decrement or the recorded insufficient-stock conflict',
  );

  const stockAfterStorm = await readStock('product-a');
  assert.equal(stockAfterStorm, 0);
  assert.equal(await appliedDecrementTotal('product-a'), 10 - stockAfterStorm, 'applied decrements must equal the delta');
  assert.equal(await countLedgerRows(), 6, 'every order id that reached the service must have a ledger row');
  t.diagnostic(
    `INV-I4 race: product-b 5 -> ${stockAfterRace} (1 of 2 accepted); storm: product-a 10 -> ${stockAfterStorm} (5 of 6 accepted)`,
  );
});

test('INV-I5 GET /products matches the seed exactly and is ordered by id', { skip }, async (t) => {
  await resetInventoryDatabase(database());

  const response = await send(baseUrl, '/products');

  assert.equal(response.status, 200);
  assert.match(String(response.headers.get('content-type')), /application\/json/);
  assert.deepEqual(response.body, SEEDED_CATALOG);
  for (const product of response.body) {
    assert.deepEqual(Object.keys(product).sort(), ['id', 'name', 'priceCents', 'sku', 'stock']);
  }

  const single = await send(baseUrl, '/products/product-b');
  assert.equal(single.status, 200);
  assert.deepEqual(single.body, SEEDED_CATALOG[1]);
  assert.deepEqual((await send(baseUrl, '/products/product-none')).body, PRODUCT_NOT_FOUND_ENVELOPE);
  t.diagnostic(`INV-I5 GET /products -> ${JSON.stringify(response.body)}`);
});

test('INV-I6 five concurrent calls for one orderId decrement exactly once', { skip }, async (t) => {
  await resetInventoryDatabase(database());
  const orderId = randomUUID();

  const responses = await Promise.all(Array.from({ length: 5 }, () => decrement(orderId, 'product-a', 2)));
  const created = responses.filter((response) => response.status === 201);
  const replays = responses.filter((response) => response.status === 200);

  assert.equal(created.length, 1, 'exactly one call may execute the decrement');
  assert.equal(replays.length, 4);
  for (const replay of replays) {
    assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
    assert.deepEqual(replay.body, created[0]?.body);
  }

  assert.equal(await readStock('product-a'), 8, 'the stock must be decremented exactly once');
  assert.equal(await countLedgerRows(), 1);
  assert.equal(await appliedDecrementTotal('product-a'), 2);
  t.diagnostic(`INV-I6 five concurrent calls: 1 x 201, 4 x 200 replay, stock ${await readStock('product-a')}`);
});

test('INV-I7 the recorded outcome survives a service restart', { skip }, async (t) => {
  await resetInventoryDatabase(database());
  const orderId = randomUUID();

  // First "instance": its own pool and process state.
  const firstPool = new Pool({ connectionString: probe.url });
  const firstServer = await startTestServer(createInventoryApplication(firstPool));
  let firstBody: unknown;
  try {
    const response = await send(
      firstServer.url,
      '/stock-decrements',
      jsonRequest('POST', { orderId, productId: 'product-a', quantity: 3 }, { 'Idempotency-Key': orderId }),
    );
    assert.equal(response.status, 201);
    firstBody = response.body;
  } finally {
    await firstServer.close();
    await firstPool.end();
  }

  // Second "instance" over the same database: only the recorded ledger row can produce the answer.
  const secondPool = new Pool({ connectionString: probe.url });
  const secondServer = await startTestServer(createInventoryApplication(secondPool));
  t.after(async () => {
    await secondServer.close();
    await secondPool.end();
  });

  const replay = await send(
    secondServer.url,
    '/stock-decrements',
    jsonRequest('POST', { orderId, productId: 'product-a', quantity: 3 }, { 'Idempotency-Key': orderId }),
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
  assert.deepEqual(replay.body, firstBody);
  assert.equal(await readStock('product-a'), 7, 'the restart must not decrement again');

  const released = await send(secondServer.url, `/stock-decrements/${orderId}/release`, { method: 'POST' });
  assert.equal(released.status, 200);
  assert.deepEqual(released.body, { orderId, status: 'RELEASED', releasedQuantity: 3, remainingStock: 10 });
  assert.equal(await readStock('product-a'), 10);
  t.diagnostic(`INV-I7 replay after restart returned ${JSON.stringify(replay.body)}`);
});

test('INV-I8 the applied schema keeps the documented constraints and seed', { skip }, async (t) => {
  await resetInventoryDatabase(database());

  const productConstraints = await database().query<{ definition: string }>(
    "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'products'::regclass",
  );
  const productDefinitions = productConstraints.rows.map((row) => row.definition).join('\n');
  assert.match(productDefinitions, /stock >= 0/, 'CHECK (stock >= 0) must be the second line of defense');

  const ledgerConstraints = await database().query<{ conname: string; definition: string }>(
    "SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'stock_decrements'::regclass",
  );
  const byName = new Map(ledgerConstraints.rows.map((row) => [row.conname, row.definition]));
  assert.match(byName.get('stock_decrements_pkey') ?? '', /PRIMARY KEY \(order_id\)/);
  assert.match(byName.get('stock_decrements_outcome_check') ?? '', /outcome = ANY/);
  assert.match(byName.get('stock_decrements_state_check') ?? '', /state = ANY/);
  assert.match(byName.get('released_requires_a_decrement') ?? '', /state <> 'RELEASED'/);

  const indexes = await database().query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'stock_decrements'",
  );
  assert.ok(indexes.rows.some((row) => row.indexname === 'stock_decrements_state_idx'));

  const products = await database().query<{ id: string }>('SELECT id FROM products ORDER BY id');
  assert.deepEqual(products.rows.map((row) => row.id), ['product-a', 'product-b']);

  // The database itself refuses to go below zero, independently of the guard in the update.
  await assert.rejects(
    () => database().query("UPDATE products SET stock = -1 WHERE id = 'product-a'"),
    /check constraint/i,
  );
  assert.equal(await readStock('product-a'), 10);
  t.diagnostic('INV-I8 schema constraints, index and seed verified against the live database');
});

test('INV-I9 rejected requests are recorded, replayed and never mutate stock', { skip }, async (t) => {
  await resetInventoryDatabase(database());
  const unknownProductOrder = randomUUID();

  const notFound = await decrement(unknownProductOrder, 'product-unknown', 1);
  assert.equal(notFound.status, 404);
  assert.deepEqual(notFound.body, PRODUCT_NOT_FOUND_ENVELOPE);
  const notFoundLedger = await readLedger(unknownProductOrder);
  assert.equal(notFoundLedger?.outcome, 'NOT_FOUND');
  assert.equal(notFoundLedger?.state, 'RECORDED');
  assert.equal(notFoundLedger?.unit_price_cents, null);

  const notFoundReplay = await decrement(unknownProductOrder, 'product-unknown', 1);
  assert.equal(notFoundReplay.status, 404);
  assert.deepEqual(notFoundReplay.body, PRODUCT_NOT_FOUND_ENVELOPE);
  assert.equal(await countLedgerRows(), 1);

  const insufficientOrder = randomUUID();
  const insufficient = await decrement(insufficientOrder, 'product-b', 6);
  assert.equal(insufficient.status, 409);
  assert.deepEqual(insufficient.body, INSUFFICIENT_STOCK_ENVELOPE);
  assert.equal((await readLedger(insufficientOrder))?.outcome, 'INSUFFICIENT_STOCK');
  assert.equal(await readStock('product-b'), 5, 'insufficient stock must not change stock');
  assert.equal((await release(insufficientOrder)).status, 409, 'a rejected outcome cannot be released');

  const invalidOrderId = randomUUID();
  const invalid = await send(
    baseUrl,
    '/stock-decrements',
    jsonRequest('POST', { orderId: invalidOrderId, productId: 'product-a', quantity: 0 }, { 'Idempotency-Key': invalidOrderId }),
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body, INVALID_ENVELOPE);

  assert.equal(await countLedgerRows(), 2, 'only the recorded outcomes may have a ledger row');
  const unknownRelease = await release(randomUUID());
  assert.equal(unknownRelease.status, 404);
  assert.deepEqual(unknownRelease.body, NO_DECREMENT_ENVELOPE);
  assert.equal(await countLedgerRows(), 2, 'a release must never create a ledger row');
  assert.equal(await readStock('product-a'), 10);
  t.diagnostic(`INV-I9 database under test: ${describeDatabaseUrl(probe.url)}`);
});
