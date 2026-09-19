/**
 * ShopFlow black-box behaviour-preservation suite (scenarios P1-P10).
 *
 * Owner: `shopflow-infra`. This is the primary evidence that the migration to the nine-service
 * composed runtime preserves the externally observable behaviour of the retired monolith.
 *
 * Only Node built-ins are used: `node:test`, `node:assert/strict`, the global `fetch` and
 * `node:child_process` for the `docker compose stop|start|up|down` steps. No package dependency and
 * no network access beyond the local stack.
 *
 * The whole file is written against `BASE_URL` and `PROVIDER_URL` only, so the identical file runs
 * against the legacy stack and the migrated stack:
 *
 *   BASE_URL              default http://localhost:3001   public API (legacy monolith or gateway)
 *   PROVIDER_URL          default http://localhost:4010   provider inspection
 *   COMPOSE_FILE          default docker-compose.yml      compose file for the outage/restart steps
 *   RECOVERY_TIMEOUT_MS   default 20000                   upper bound while waiting for recovery
 *   STARTUP_TIMEOUT_MS    default 240000                  upper bound while waiting for health
 *
 * Run: `node --test tests/` (or `node --test tests/behavior-preservation.test.js`). `tests/index.js`
 * is the suite entry point, so the documented directory form works on Node.js 22+ as well, where a
 * positional argument is executed as a test file instead of being searched recursively.
 *
 * Scenarios marked migration-only on the legacy stack record the reason in a diagnostic instead of
 * failing: the legacy topology has no individually restartable `inventory`/`orders` services, so
 * those failures cannot even be produced there. That is recorded, never silently skipped.
 *
 * Self-cleaning: the suite resets the stack from clean volumes before the first scenario and P10
 * resets it again at the end, so a run neither depends on nor leaves rows behind and a second run
 * starts from the documented seed. Services are started and stopped only through `docker compose` on
 * `COMPOSE_FILE`, so the topology under test is the delivered topology.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const BASE_URL = trimTrailingSlashes(process.env.BASE_URL ?? 'http://localhost:3001');
const PROVIDER_URL = trimTrailingSlashes(process.env.PROVIDER_URL ?? 'http://localhost:4010');
const COMPOSE_FILE = process.env.COMPOSE_FILE ?? 'docker-compose.yml';
const RECOVERY_TIMEOUT_MS = positiveInteger(process.env.RECOVERY_TIMEOUT_MS, 20000);
const STARTUP_TIMEOUT_MS = positiveInteger(process.env.STARTUP_TIMEOUT_MS, 240000);
const LEGACY_DEVIATION_GRACE_MS = positiveInteger(process.env.LEGACY_DEVIATION_GRACE_MS, 3000);

/** Internal diagnostic endpoint of the orders service used by the recovery scenario (P9). */
const ORDER_ROW_COUNT_SQL = 'select count(*) from orders';
const UNKNOWN_ORDER_ID = '00000000-0000-4000-8000-000000000000';
const BUYER = 'buyer@example.com';

const ERROR_INVALID = {
  error: 'A product, positive whole quantity, and valid email are required',
  code: 'INVALID',
};
const ERROR_STOCK = { error: 'Insufficient stock', code: 'INSUFFICIENT_STOCK' };
const ERROR_PRODUCT_NOT_FOUND = { error: 'Product not found', code: 'NOT_FOUND' };
const ERROR_ORDER_NOT_FOUND = { error: 'Order not found', code: 'NOT_FOUND' };
const ERROR_INVALID_STATUS = { error: 'Only CONFIRMED orders can be shipped', code: 'INVALID_STATUS' };
const ERROR_INTERNAL = { error: 'Internal server error' };
const ERROR_UNAVAILABLE = { error: 'Upstream service unavailable', code: 'UNAVAILABLE' };

const SEEDED_CATALOG = [
  { id: 'product-a', sku: 'SKU-A', name: 'Product A', priceCents: 1200, stock: 10 },
  { id: 'product-b', sku: 'SKU-B', name: 'Product B', priceCents: 2500, stock: 5 },
];

// ---------------------------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------------------------

function trimTrailingSlashes(value) {
  return String(value).replace(/\/+$/, '');
}

function positiveInteger(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function oneLine(text, limit = 400) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}...` : collapsed;
}

function diagnostic(t, message) {
  t.diagnostic(message);
}

// ---------------------------------------------------------------------------------------------
// docker compose / stack control
// ---------------------------------------------------------------------------------------------

function compose(args) {
  const result = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    error: result.error,
  };
}

function composeServices() {
  const result = compose(['config', '--services']);
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function composePsRows() {
  const result = compose(['ps', '--format', 'json']);
  if (result.status !== 0 || result.stdout === '') {
    return [];
  }
  if (result.stdout.startsWith('[')) {
    try {
      return JSON.parse(result.stdout);
    } catch {
      /* fall through to NDJSON parsing */
    }
  }
  const rows = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate.startsWith('{')) {
      continue;
    }
    try {
      rows.push(JSON.parse(candidate));
    } catch {
      /* ignore malformed line */
    }
  }
  return rows;
}

function rowIsHealthy(row) {
  const health = String(row.Health ?? '').toLowerCase();
  const state = String(row.State ?? '').toLowerCase();
  const status = String(row.Status ?? '').toLowerCase();
  if (state === 'exited' || status.startsWith('exited')) {
    const fromStatus = (status.match(/\((\d+)\)/) ?? [])[1];
    return String(row.ExitCode ?? fromStatus ?? '0') === '0';
  }
  return health === 'healthy';
}

function describeComposePs(rows) {
  return rows
    .map((row) => {
      const condition = row.Health
        ? String(row.Health)
        : String(row.State ?? row.Status ?? 'unknown');
      return `${row.Service ?? row.Name ?? '?'}=${condition}`;
    })
    .join(' ');
}

async function waitForComposeHealthy(timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  for (;;) {
    rows = composePsRows();
    if (rows.length > 0 && rows.every(rowIsHealthy)) {
      return { ok: true, rows };
    }
    if (Date.now() >= deadline) {
      return { ok: false, rows };
    }
    await delay(1000);
  }
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try {
      value = await predicate();
    } catch {
      value = undefined;
    }
    if (value) {
      return value;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await delay(intervalMs);
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers (BASE_URL / PROVIDER_URL only)
// ---------------------------------------------------------------------------------------------

async function request(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { response, status: response.status, text, body, headers: response.headers };
}

function api(path, init) {
  return request(`${BASE_URL}${path}`, init);
}

function provider(path, init) {
  return request(`${PROVIDER_URL}${path}`, init);
}

function jsonRequest(method, payload, extraHeaders = {}) {
  return {
    method,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  };
}

function createOrder(payload, extraHeaders = {}) {
  return api('/orders', jsonRequest('POST', payload, extraHeaders));
}

function listProducts() {
  return api('/products');
}

function listProviderRecords() {
  return provider('/notifications');
}

function shipOrder(orderId) {
  return api(`/admin/orders/${orderId}/ship`, { method: 'POST' });
}

async function catalog() {
  const { status, body, text } = await listProducts();
  assert.equal(status, 200, `GET /products must answer 200 (received ${status}: ${oneLine(text)})`);
  assert.ok(Array.isArray(body), 'GET /products must answer a JSON array');
  return body;
}

function stockOf(products, productId) {
  const product = products.find((entry) => entry?.id === productId);
  assert.ok(product, `product ${productId} must exist in the catalog`);
  return product.stock;
}

async function providerRecords() {
  const { status, body, text } = await listProviderRecords();
  assert.equal(status, 200, `GET /notifications must answer 200 (received ${status}: ${oneLine(text)})`);
  assert.ok(Array.isArray(body), 'GET /notifications must answer a JSON array');
  return body;
}

function providerRecordsFor(records, orderId) {
  return records.filter((record) => record?.orderId === orderId);
}

function assertStatusAndBody(actual, expectedStatus, expectedBody, context) {
  assert.equal(
    actual.status,
    expectedStatus,
    `${context}: expected HTTP ${expectedStatus}, received ${actual.status} (${oneLine(actual.text)})`,
  );
  assert.deepEqual(actual.body, expectedBody, `${context}: unexpected error envelope`);
}

/** Which database currently holds the orders rows (the P3 step 6 probe). */
function orderDatabase() {
  return stack.target === 'legacy'
    ? { service: 'db', user: 'shopflow', database: 'shopflow', variant: 'legacy shared db (psql -U shopflow -d shopflow)' }
    : { service: 'orders-db', user: 'orders', database: 'orders', variant: 'migrated orders-db (psql -U orders -d orders)' };
}

function countOrderRows() {
  const { service, user, database } = orderDatabase();
  const result = compose(['exec', '-T', service, 'psql', '-U', user, '-d', database, '-tAc', ORDER_ROW_COUNT_SQL]);
  assert.equal(
    result.status,
    0,
    `docker compose exec ${service} psql failed: ${oneLine(result.stderr || result.stdout)}`,
  );
  const value = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  return Number(value);
}

// ---------------------------------------------------------------------------------------------
// suite state
// ---------------------------------------------------------------------------------------------

const stack = {
  target: 'migrated',
  services: [],
  ready: false,
  error: null,
  rows: [],
};

const results = [];

function detectTarget() {
  const services = composeServices();
  const target =
    services.includes('gateway') && services.includes('orders') && services.includes('inventory')
      ? 'migrated'
      : services.includes('api') || services.includes('db')
        ? 'legacy'
        : 'unknown';
  return { services, target };
}

function apiReachable() {
  return fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) })
    .then((response) => response.ok)
    .catch(() => false);
}

function assertStackReady(scenario) {
  assert.ok(
    stack.ready,
    `${scenario} cannot run against this stack: ${stack.error ?? 'the composed stack is not reachable'}`,
  );
}

async function startStackFromCleanVolumes(scenario) {
  const down = compose(['down', '-v']);
  const up = compose(['up', '--build', '-d']);
  const health = up.status === 0 ? await waitForComposeHealthy() : { ok: false, rows: composePsRows() };
  const reachable = health.ok ? true : await apiReachable();
  assert.ok(
    reachable,
    `${scenario}: the composed stack is not running after \`docker compose down -v\` + \`up --build -d\` ` +
      `(down=${down.status}, up=${up.status}; ${oneLine(up.stderr || up.stdout) || 'no output'})`,
  );
  return health.rows;
}

async function waitForStock(productId, expected, label) {
  const rows = await waitFor(
    async () => {
      const current = await catalog();
      return stockOf(current, productId) === expected ? current : undefined;
    },
    { timeoutMs: RECOVERY_TIMEOUT_MS, intervalMs: 500 },
  );
  assert.ok(
    rows,
    `${label}: product ${productId} stock did not reach ${expected} within ${RECOVERY_TIMEOUT_MS} ms`,
  );
  return rows;
}

// ---------------------------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------------------------

/** P1 - product catalog (preserved capability 1). */
async function p1(t) {
  assertStackReady('P1');
  const { status, body, headers, text } = await listProducts();
  assert.equal(status, 200, `GET /products must answer 200 (received ${status}: ${oneLine(text)})`);
  assert.match(String(headers.get('content-type')), /application\/json/);
  assert.ok(Array.isArray(body), 'GET /products must answer a JSON array');
  assert.equal(body.length, 2, 'the catalog must contain exactly the two seeded products');
  assert.deepEqual(body, SEEDED_CATALOG, 'the catalog must match the seed, ordered by id');
  for (const product of body) {
    assert.deepEqual(
      Object.keys(product).sort(),
      ['id', 'name', 'priceCents', 'sku', 'stock'],
      'products must expose no field beyond id, sku, name, priceCents, stock',
    );
  }
  diagnostic(t, `P1 GET /products -> ${JSON.stringify(body)}`);
}

/** P2 - order creation end to end (capabilities 3, 5, 8). */
async function p2(t) {
  assertStackReady('P2');
  const created = await createOrder({ productId: 'product-a', quantity: 3, customerEmail: BUYER });
  assert.equal(
    created.status,
    201,
    `POST /orders must answer 201 (received ${created.status}: ${oneLine(created.text)})`,
  );
  const order = created.body;
  assert.equal(order.status, 'CONFIRMED');
  assert.equal(order.productId, 'product-a');
  assert.equal(order.quantity, 3);
  assert.equal(order.totalCents, 3600);
  assert.equal(order.customerEmail, BUYER);
  assert.equal(typeof order.id, 'string');
  assert.ok(order.id.length > 0, 'the order must have a non-empty id');
  assert.match(
    String(order.createdAt),
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    'createdAt must be an ISO 8601 UTC timestamp',
  );

  const detail = await api(`/orders/${order.id}`);
  assert.equal(detail.status, 200, `GET /orders/:id must answer 200 (${oneLine(detail.text)})`);
  for (const field of ['id', 'customerEmail', 'status', 'productId', 'quantity', 'totalCents', 'createdAt']) {
    assert.deepEqual(detail.body[field], order[field], `GET /orders/:id must preserve ${field}`);
  }

  const products = await catalog();
  assert.equal(stockOf(products, 'product-a'), 7, 'exactly one decrement of 3 must be applied');

  const records = await providerRecords();
  const forOrder = providerRecordsFor(records, order.id);
  assert.equal(forOrder.length, 1, 'exactly one confirmation must exist for the order');
  const { id: recordId, ...message } = forOrder[0];
  assert.equal(typeof recordId, 'string');
  assert.deepEqual(message, { type: 'ORDER_CONFIRMATION', orderId: order.id, customerEmail: BUYER });

  diagnostic(t, `P2 POST /orders -> ${JSON.stringify(order)}`);
  diagnostic(t, `P2 GET /products -> product-a stock ${stockOf(products, 'product-a')}`);
  diagnostic(t, `P2 GET ${PROVIDER_URL}/notifications -> ${JSON.stringify(forOrder)}`);
}

/** P3 - inventory validation and no-op rejection (capabilities 4 and 2). */
async function p3(t) {
  assertStackReady('P3');
  const { variant } = orderDatabase();
  const recordsBefore = (await providerRecords()).length;
  const stockBefore = stockOf(await catalog(), 'product-b');
  assert.equal(stockBefore, 5, 'P3 must start from the seeded product-b stock');
  const rowsBefore = countOrderRows();
  diagnostic(t, `P3 step 6 order-row count via ${variant}: ${rowsBefore}`);

  assertStatusAndBody(
    await createOrder({ productId: 'product-b', quantity: 6, customerEmail: BUYER }),
    400,
    ERROR_STOCK,
    'P3 insufficient stock',
  );
  assert.equal(stockOf(await catalog(), 'product-b'), 5, 'insufficient stock must not change stock');
  assert.equal((await providerRecords()).length, recordsBefore, 'insufficient stock must not notify');
  assert.equal(countOrderRows(), rowsBefore, 'insufficient stock must not create an order row');

  assertStatusAndBody(
    await createOrder({ productId: 'product-unknown', quantity: 1, customerEmail: BUYER }),
    404,
    ERROR_PRODUCT_NOT_FOUND,
    'P3 unknown product',
  );
  assert.equal(stockOf(await catalog(), 'product-b'), 5, 'an unknown product must not change stock');
  assert.equal(countOrderRows(), rowsBefore, 'an unknown product must not create an order row');

  assertStatusAndBody(
    await createOrder({ productId: 'product-a', quantity: 0, customerEmail: BUYER }),
    400,
    ERROR_INVALID,
    'P3 quantity 0',
  );
  assertStatusAndBody(
    await createOrder({ productId: 'product-a', quantity: 1, customerEmail: 'nope' }),
    400,
    ERROR_INVALID,
    'P3 invalid email',
  );
  assert.equal(countOrderRows(), rowsBefore, 'invalid input must not create an order row');
  assert.equal((await providerRecords()).length, recordsBefore, 'invalid input must not notify');

  diagnostic(t, `P3 order rows before/after: ${rowsBefore}/${countOrderRows()}`);
  diagnostic(t, `P3 provider records before/after: ${recordsBefore}/${(await providerRecords()).length}`);
}

/** P4 - order detail and status (capability 6). */
async function p4(t) {
  assertStackReady('P4');
  const created = await createOrder({ productId: 'product-a', quantity: 1, customerEmail: BUYER });
  assert.equal(created.status, 201, `P4 helper create must answer 201 (${oneLine(created.text)})`);
  const orderId = created.body.id;

  const detail = await api(`/orders/${orderId}`);
  assert.equal(detail.status, 200, `GET /orders/:id must answer 200 (${oneLine(detail.text)})`);
  assert.equal(detail.body.status, 'CONFIRMED');
  assert.equal(detail.body.id, orderId);

  assertStatusAndBody(
    await api(`/orders/${UNKNOWN_ORDER_ID}`),
    404,
    ERROR_ORDER_NOT_FOUND,
    'P4 unknown order',
  );

  diagnostic(t, `P4 GET /orders/${orderId} -> ${JSON.stringify(detail.body)}`);
}

/** P5 - administrative transition to SHIPPED (capability 7). */
async function p5(t) {
  assertStackReady('P5');
  const created = await createOrder({ productId: 'product-b', quantity: 1, customerEmail: BUYER });
  assert.equal(created.status, 201, `P5 helper create must answer 201 (${oneLine(created.text)})`);
  const orderId = created.body.id;
  const stockBefore = stockOf(await catalog(), 'product-b');
  const recordsBefore = (await providerRecords()).length;

  const shipped = await shipOrder(orderId);
  assert.equal(shipped.status, 200, `POST /admin/orders/:id/ship must answer 200 (${oneLine(shipped.text)})`);
  assert.equal(shipped.body.status, 'SHIPPED');
  assert.equal(shipped.body.id, orderId);

  const detail = await api(`/orders/${orderId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.status, 'SHIPPED', 'the transition must be persisted');

  assertStatusAndBody(await shipOrder(orderId), 409, ERROR_INVALID_STATUS, 'P5 repeated ship');
  assertStatusAndBody(
    await shipOrder(UNKNOWN_ORDER_ID),
    404,
    ERROR_ORDER_NOT_FOUND,
    'P5 unknown order ship',
  );

  assert.equal(stockOf(await catalog(), 'product-b'), stockBefore, 'shipping must not touch stock');
  assert.equal((await providerRecords()).length, recordsBefore, 'shipping must not notify');

  diagnostic(t, `P5 POST /admin/orders/${orderId}/ship -> ${JSON.stringify(shipped.body)}`);
}

/** P6 - provider failure surfaces as an error while the order survives (migration-only deviation). */
async function p6(t) {
  assertStackReady('P6');
  const providerService = stack.target === 'legacy' ? 'notifications' : 'notification-emulator';
  assert.ok(
    stack.services.includes(providerService),
    `P6 needs a ${providerService} service in the compose topology (saw: ${stack.services.join(', ')})`,
  );

  const idempotencyKey = `P6-${process.pid}-${Date.now()}`;
  const payload = { productId: 'product-a', quantity: 2, customerEmail: BUYER };
  const stockBefore = stockOf(await catalog(), 'product-a');
  const recordsBefore = (await providerRecords()).length;

  const stopped = compose(['stop', providerService]);
  assert.equal(stopped.status, 0, `docker compose stop ${providerService}: ${oneLine(stopped.stderr || stopped.stdout)}`);
  try {
    const created = await createOrder(payload, { 'Idempotency-Key': idempotencyKey });
    assertStatusAndBody(created, 500, ERROR_INTERNAL, 'P6 provider outage');
    diagnostic(t, `P6 POST /orders with ${providerService} stopped -> 500 ${oneLine(created.text)}`);
  } finally {
    const started = compose(['start', providerService]);
    assert.equal(started.status, 0, `docker compose start ${providerService}: ${oneLine(started.stderr || started.stdout)}`);
  }

  assert.equal(
    stockOf(await catalog(), 'product-a'),
    stockBefore - 2,
    'the order is committed, so the stock decrement is applied even though the confirmation failed',
  );

  if (stack.target === 'legacy') {
    await delay(LEGACY_DEVIATION_GRACE_MS);
    const afterOutage = (await providerRecords()).length;
    // The provider keeps its records in the provider process memory, so stopping its service may
    // reset the inspection list. What must not happen on the legacy stack is a new delivery, so the
    // count must not grow past the pre-outage baseline (it may legitimately drop to zero).
    assert.ok(
      afterOutage <= recordsBefore,
      'legacy stack: the lost confirmation must not be retried (documented deviation) - the record ' +
        `count must not grow past the pre-outage baseline (before: ${recordsBefore}, after: ${afterOutage})`,
    );
    diagnostic(
      t,
      'P6 documented deviation: the legacy stack loses the confirmation when the provider is unavailable; ' +
        'the migrated stack keeps a durable outbox row and delivers exactly one confirmation after the provider returns.',
    );
    return;
  }

  // The provider keeps its records in the provider process memory, so stopping and starting its
  // service either resets the inspection list (the process restarted) or preserves it. Both outcomes
  // are valid, and the retried confirmation is identified by the order id it carries:
  //   - list preserved -> the confirmation appended after the pre-outage baseline;
  //   - list reset     -> the single record present, which is the confirmation the durable outbox has
  //                       just delivered (the provider cannot deduplicate, but after the restart it
  //                       has nothing left to duplicate).
  const delivered = await waitFor(
    async () => {
      const records = await providerRecords();
      const confirmations = records.filter((record) => record.type === 'ORDER_CONFIRMATION');
      if (confirmations.length === recordsBefore + 1) {
        return confirmations.slice(recordsBefore);
      }
      if (records.length === 1 && confirmations.length === 1) {
        return confirmations;
      }
      return undefined;
    },
    { timeoutMs: RECOVERY_TIMEOUT_MS, intervalMs: 500 },
  );
  assert.ok(
    delivered,
    `the confirmation must be delivered within ${RECOVERY_TIMEOUT_MS} ms after the provider returned`,
  );
  assert.equal(delivered.length, 1, 'exactly one confirmation must be delivered');
  const orderId = delivered[0].orderId;
  assert.ok(orderId, 'the delivered confirmation must carry the order id');

  const detail = await api(`/orders/${orderId}`);
  assert.equal(detail.status, 200, `GET /orders/:id must answer 200 (${oneLine(detail.text)})`);
  assert.equal(detail.body.status, 'CONFIRMED', 'the order must have survived the failed confirmation');
  assert.equal(detail.body.quantity, 2);
  assert.equal(stockOf(await catalog(), 'product-a'), stockBefore - 2, 'exactly one decrement of 2');

  const replay = await createOrder(payload, { 'Idempotency-Key': idempotencyKey });
  assert.equal(replay.status, 200, `replaying the Idempotency-Key must return the committed order (${oneLine(replay.text)})`);
  assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
  assert.equal(replay.body.id, orderId, 'the replay must return the order created by the first request');

  // Keyed on the order id, so this holds whether or not the provider lost its list during the outage:
  // the order must have been confirmed exactly once, and the replay must not add a second delivery.
  assert.equal(
    providerRecordsFor(await providerRecords(), orderId).length,
    1,
    'exactly one confirmation must exist for the order after the outage and the replay',
  );

  diagnostic(t, `P6 GET ${PROVIDER_URL}/notifications -> ${JSON.stringify(delivered[0])}`);
  diagnostic(
    t,
    'P6 documented deviation vs the legacy baseline: the legacy stack loses this confirmation ' +
      '(record count unchanged); the migrated stack delivers it exactly once from the durable outbox.',
  );
}

/** P7 - no customer cancellation (prohibition). */
async function p7(t) {
  assertStackReady('P7');
  const created = await createOrder({ productId: 'product-a', quantity: 1, customerEmail: BUYER });
  assert.equal(created.status, 201, `P7 helper create must answer 201 (${oneLine(created.text)})`);
  const orderId = created.body.id;
  const stockBefore = stockOf(await catalog(), 'product-a');

  const cancelled = await api(`/orders/${orderId}/cancel`, { method: 'POST' });
  assert.equal(cancelled.status, 404, `POST /orders/:id/cancel must not exist (${oneLine(cancelled.text)})`);
  const deleted = await api(`/orders/${orderId}`, { method: 'DELETE' });
  assert.equal(deleted.status, 404, `DELETE /orders/:id must not exist (${oneLine(deleted.text)})`);

  const detail = await api(`/orders/${orderId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.status, 'CONFIRMED', 'the status must be unchanged');
  assert.equal(stockOf(await catalog(), 'product-a'), stockBefore, 'the stock must be unchanged');

  diagnostic(t, `P7 POST /orders/:id/cancel -> ${cancelled.status}; DELETE /orders/:id -> ${deleted.status}`);
}

/** P8 - confirmation delivered once despite duplicate dispatches (capability 8). */
async function p8(t) {
  assertStackReady('P8');
  const idempotencyKey = `P8-${process.pid}-${Date.now()}`;
  const payload = { productId: 'product-a', quantity: 1, customerEmail: BUYER };

  const first = await createOrder(payload, { 'Idempotency-Key': idempotencyKey });
  assert.equal(first.status, 201, `P8 first create must answer 201 (${oneLine(first.text)})`);
  const orderId = first.body.id;
  const stockAfterFirst = stockOf(await catalog(), 'product-a');

  const second = await createOrder(payload, { 'Idempotency-Key': idempotencyKey });
  const third = await createOrder(payload, { 'Idempotency-Key': idempotencyKey });
  const replaySupported = second.status === 200 && second.headers.get('x-idempotent-replay') === 'true';

  if (replaySupported) {
    assert.equal(third.status, 200);
    assert.equal(third.headers.get('x-idempotent-replay'), 'true');
    assert.equal(second.body.id, orderId, 'the replay must return the same order');
    assert.equal(third.body.id, orderId, 'the replay must return the same order');
    assert.equal(
      stockOf(await catalog(), 'product-a'),
      stockAfterFirst,
      'a replayed create must not decrement stock a second time',
    );
    const records = await providerRecords();
    assert.equal(providerRecordsFor(records, orderId).length, 1, 'exactly one confirmation must exist');
    const detail = await api(`/orders/${orderId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.id, orderId);
    diagnostic(t, `P8 replay supported: ${first.status}, ${second.status}, ${third.status} for order ${orderId}`);
    diagnostic(t, `P8 GET ${PROVIDER_URL}/notifications -> ${JSON.stringify(providerRecordsFor(records, orderId))}`);
  } else {
    // The legacy stack ignores Idempotency-Key and creates a second order; the deviation is
    // recorded, and the property that still holds on both stacks is asserted per order id.
    assert.equal(second.status, 201, `legacy: POST /orders ignores Idempotency-Key (${oneLine(second.text)})`);
    for (const created of [first, second, third]) {
      const records = await providerRecords();
      assert.equal(
        providerRecordsFor(records, created.body.id).length,
        1,
        `every created order must be confirmed exactly once (${created.body.id})`,
      );
    }
    diagnostic(
      t,
      'P8 documented deviation: the legacy stack does not support the Idempotency-Key header, so a repeated ' +
        'create request produces a second order and a second confirmation; the migrated stack replays instead.',
    );
  }

  diagnostic(
    t,
    'P8 internal-access step: shopflow-notifications publishes no host port by design, so the notifications ' +
      'interface cannot be called twice directly from this black-box suite; the equivalent public duplicate ' +
      'dispatch (repeated POST /orders with the same Idempotency-Key) is exercised above.',
  );
}

/** P9 - ambiguous failure, restart and stock exactness (migration-only, capabilities 2, 3, 5). */
async function p9(t, outcome) {
  if (stack.target !== 'migrated') {
    outcome.migrationOnly =
      'the legacy topology is a single `api` monolith over one shared `db` (compose services: ' +
      `${stack.services.join(', ') || 'none'}): an ambiguous decrement outcome and a mid-saga crash cannot be ` +
      'produced there. Recorded as migration-only, not silently skipped.';
    diagnostic(t, `P9 is migration-only: ${outcome.migrationOnly}`);
    return;
  }

  const idempotencyKey = `P9-${process.pid}-${Date.now()}`;
  const payload = { productId: 'product-a', quantity: 4, customerEmail: BUYER };

  // 1. reset to the seed
  const rows = await startStackFromCleanVolumes('P9 step 1');
  diagnostic(t, `P9 step 1 compose ps: ${describeComposePs(rows)}`);

  try {
    // 2. stop the inventory owner
    const stopInventory = compose(['stop', 'inventory']);
    assert.equal(stopInventory.status, 0, `docker compose stop inventory: ${oneLine(stopInventory.stderr)}`);

    // 3. ambiguous create: the decrement outcome is unknown
    const ambiguous = await createOrder(payload, { 'Idempotency-Key': idempotencyKey });
    assertStatusAndBody(ambiguous, 503, ERROR_UNAVAILABLE, 'P9 ambiguous inventory failure');
    diagnostic(t, `P9 step 3 POST /orders with inventory stopped -> 503 ${oneLine(ambiguous.text)}`);

    // 4. crash the orchestrator while the saga is unresolved, then bring inventory back
    const stopOrders = compose(['stop', 'orders']);
    assert.equal(stopOrders.status, 0, `docker compose stop orders: ${oneLine(stopOrders.stderr)}`);
    const startInventory = compose(['start', 'inventory']);
    assert.equal(startInventory.status, 0, `docker compose start inventory: ${oneLine(startInventory.stderr)}`);

    // 5. restart the orchestrator; its recovery worker resolves the saga
    const startOrders = compose(['start', 'orders']);
    assert.equal(startOrders.status, 0, `docker compose start orders: ${oneLine(startOrders.stderr)}`);
  } finally {
    // never leave the stack with a stopped service behind
    compose(['start', 'inventory']);
    compose(['start', 'orders']);
  }

  const health = await waitForComposeHealthy();
  assert.ok(health.ok, `the stack must return to a healthy steady state (${describeComposePs(health.rows)})`);

  // 6. exactly one decrement of 4: 10 -> 6
  await waitForStock('product-a', 6, 'P9 step 6');

  // 7. resolve the order id through the deterministic Idempotency-Key replay
  const replay = await waitFor(
    async () => {
      const candidate = await createOrder(payload, { 'Idempotency-Key': idempotencyKey });
      return candidate.status === 200 && candidate.headers.get('x-idempotent-replay') === 'true'
        ? candidate
        : undefined;
    },
    { timeoutMs: RECOVERY_TIMEOUT_MS, intervalMs: 500 },
  );
  assert.ok(
    replay,
    `P9 step 7: the recovery worker must resolve the saga within ${RECOVERY_TIMEOUT_MS} ms; replaying the ` +
      'Idempotency-Key never answered 200 with x-idempotent-replay: true',
  );
  const orderId = replay.body.id;
  assert.ok(orderId, 'the replay must carry the order id');
  assert.equal(stockOf(await catalog(), 'product-a'), 6, 'the replayed request must not decrement again');

  const operations = await api(`/orders/${orderId}/operations`);
  assert.equal(operations.status, 200, `GET /orders/:id/operations must answer 200 (${oneLine(operations.text)})`);
  diagnostic(t, `P9 step 7 GET /orders/${orderId}/operations -> ${JSON.stringify(operations.body)}`);
  assert.equal(operations.body.state, 'COMPLETED', 'the saga must reach COMPLETED exactly once');
  assert.equal(operations.body.decrementOutcome, 'DECREMENTED');
  assert.equal(operations.body.orderId, orderId);
  assert.equal(operations.body.quantity, 4);

  const detail = await api(`/orders/${orderId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.quantity, 4);
  assert.equal(detail.body.totalCents, 4800);

  // 8. exactly one order row and exactly one delivered confirmation
  assert.equal(countOrderRows(), 1, 'exactly one order row must exist for the recovered saga');
  const records = await waitFor(
    async () => {
      const current = await providerRecords();
      return providerRecordsFor(current, orderId).length >= 1 ? current : undefined;
    },
    { timeoutMs: RECOVERY_TIMEOUT_MS, intervalMs: 500 },
  );
  assert.ok(records, 'exactly one confirmation must be delivered for the recovered order');
  assert.equal(providerRecordsFor(records, orderId).length, 1);
  const { id: recordId, ...message } = providerRecordsFor(records, orderId)[0];
  assert.equal(typeof recordId, 'string');
  assert.deepEqual(message, { type: 'ORDER_CONFIRMATION', orderId, customerEmail: BUYER });
  diagnostic(t, `P9 step 8 GET ${PROVIDER_URL}/notifications -> ${JSON.stringify(providerRecordsFor(records, orderId))}`);

  // 9. restart the orchestrator again: recovery must be idempotent
  const restartStop = compose(['stop', 'orders']);
  assert.equal(restartStop.status, 0, `docker compose stop orders: ${oneLine(restartStop.stderr)}`);
  const restartStart = compose(['start', 'orders']);
  assert.equal(restartStart.status, 0, `docker compose start orders: ${oneLine(restartStart.stderr)}`);
  const healthAfter = await waitForComposeHealthy();
  assert.ok(healthAfter.ok, `the stack must be healthy after the second restart (${describeComposePs(healthAfter.rows)})`);
  await delay(2 * 1000);

  assert.equal(stockOf(await catalog(), 'product-a'), 6, 'idempotent recovery: the second restart must not change stock');
  assert.equal(countOrderRows(), 1, 'idempotent recovery: the second restart must not add an order row');
  assert.equal(
    providerRecordsFor(await providerRecords(), orderId).length,
    1,
    'idempotent recovery: the second restart must not double-deliver',
  );
}

/** P10 - composed runtime readiness. */
async function p10(t) {
  assertStackReady('P10');

  // 1. docker compose config renders without warnings and without retired references
  const config = compose(['config']);
  assert.equal(config.status, 0, `docker compose config failed: ${oneLine(config.stderr || config.stdout)}`);
  assert.equal(config.stderr, '', `docker compose config emitted warnings: ${oneLine(config.stderr)}`);
  for (const retired of [
    'shopflow-api',
    'postgres/init.sql',
    'shopflow:shopflow@db:5432/shopflow',
    'postgres-db',
  ]) {
    assert.ok(
      !config.stdout.toLowerCase().includes(retired.toLowerCase()),
      `docker compose config must not reference the retired ${retired}`,
    );
  }
  diagnostic(t, 'P10 step 1 docker compose config: rendered without warnings, no retired reference');

  // 2. up --build -d and wait for every healthcheck
  const up = compose(['up', '--build', '-d']);
  assert.equal(up.status, 0, `docker compose up --build -d failed: ${oneLine(up.stderr || up.stdout)}`);
  const health = await waitForComposeHealthy();
  const ps = compose(['ps']);
  diagnostic(t, `P10 step 2 docker compose ps:\n${ps.stdout}`);
  assert.ok(
    health.ok,
    `every service must become healthy (or exit 0 for one-shot init): ${describeComposePs(health.rows)}`,
  );

  // 3. exactly the nine documented services
  assert.equal(health.rows.length, 9, `the composed runtime must run nine services (saw ${health.rows.length})`);
  assert.deepEqual(
    health.rows.map((row) => row.Service).sort(),
    [
      'gateway',
      'inventory',
      'inventory-db',
      'notification-emulator',
      'notifications',
      'notifications-db',
      'orders',
      'orders-db',
      'web',
    ],
    'the nine services must be exactly the documented set',
  );
  assert.ok(!stack.services.includes('db'), 'no shared `db` service may exist');
  assert.ok(!stack.services.includes('api'), 'the retired `api` service must not exist');

  // 4. down -v + up must restore the exact seed
  const down = compose(['down', '-v']);
  assert.equal(down.status, 0, `docker compose down -v failed: ${oneLine(down.stderr || down.stdout)}`);
  const up2 = compose(['up', '--build', '-d']);
  assert.equal(up2.status, 0, `docker compose up --build -d failed: ${oneLine(up2.stderr || up2.stdout)}`);
  const health2 = await waitForComposeHealthy();
  assert.ok(health2.ok, `the stack must be healthy after the reset: ${describeComposePs(health2.rows)}`);

  const products = await catalog();
  assert.equal(stockOf(products, 'product-a'), 10, 'down -v must restore product-a stock 10');
  assert.equal(stockOf(products, 'product-b'), 5, 'down -v must restore product-b stock 5');
  assert.equal(countOrderRows(), 0, 'down -v must leave the orders table empty');
  assert.deepEqual(await providerRecords(), [], 'down -v must leave the provider with no records');
  diagnostic(t, `P10 step 4 after reset GET /products -> ${JSON.stringify(products)}`);
}

// ---------------------------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------------------------

async function scenario(t, id, title, body) {
  // A scenario body may declare itself migration-only (it cannot be produced on the legacy
  // topology): that is reported as its own outcome, never as a pass.
  const outcome = { migrationOnly: null };
  let failure = null;
  await t.test(`${id} ${title}`, async (subtest) => {
    subtest.diagnostic(`target=${stack.target}`);
    try {
      await body(subtest, outcome);
    } catch (error) {
      failure = error;
      throw error;
    }
  });
  const status = failure !== null ? 'FAIL' : outcome.migrationOnly !== null ? 'MIGRATION-ONLY' : 'PASS';
  results.push({
    id,
    title,
    status,
    detail: failure !== null ? oneLine(failure.message ?? failure, 220) : (outcome.migrationOnly ?? ''),
  });
}

function printTable(t) {
  const lines = ['', 'SCENARIO | STATUS | DETAIL'];
  for (const result of results) {
    lines.push(`${result.id} | ${result.status} | ${result.detail || result.title}`);
  }
  const failed = results.filter((result) => result.status === 'FAIL').length;
  const migrationOnly = results.filter((result) => result.status === 'MIGRATION-ONLY').length;
  const passed = results.filter((result) => result.status === 'PASS').length;
  lines.push(
    `TOTAL | ${passed} PASSED | ${failed} FAILED | ${migrationOnly} MIGRATION-ONLY | ${results.length} SCENARIOS`,
  );
  const table = lines.join('\n');
  t.diagnostic(table);
  console.log(table);
}

function firstMeaningfulLine(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.find((line) => /error|unable|failed|cannot|not found|denied/i.test(line)) ??
    lines[lines.length - 1] ??
    ''
  );
}

test('ShopFlow composed runtime - behaviour preservation (P1-P10)', async (t) => {
  const detected = detectTarget();
  stack.target = detected.target;
  stack.services = detected.services;

  t.diagnostic(`BASE_URL=${BASE_URL} PROVIDER_URL=${PROVIDER_URL} COMPOSE_FILE=${COMPOSE_FILE}`);
  t.diagnostic(`RECOVERY_TIMEOUT_MS=${RECOVERY_TIMEOUT_MS} STARTUP_TIMEOUT_MS=${STARTUP_TIMEOUT_MS}`);
  t.diagnostic(`stack target: ${stack.target}`);
  t.diagnostic(`compose services: ${stack.services.join(', ') || '(none)'}`);

  // Reset to the exact seed and bring the composed topology up before any scenario runs. Every
  // scenario after this one starts from the documented seed state, so the suite is re-runnable
  // from a clean volume without manual intervention.
  const down = compose(['down', '-v']);
  const up = compose(['up', '--build', '-d']);
  // A failed `up` can never become healthy: fail fast instead of waiting out the startup budget.
  const health = up.status === 0 ? await waitForComposeHealthy() : { ok: false, rows: composePsRows() };
  stack.rows = health.rows;
  stack.ready = health.ok ? true : await apiReachable();
  if (!stack.ready) {
    stack.error =
      `the composed stack is not running after \`docker compose down -v\` + \`up --build -d\` ` +
      `(down=${down.status}, up=${up.status}): ` +
      `${firstMeaningfulLine(up.stderr) || firstMeaningfulLine(up.stdout) || 'no output'}`;
  }

  t.diagnostic(
    `setup: docker compose down -v status=${down.status}; docker compose up --build -d status=${up.status}; ` +
      `all healthy=${health.ok}`,
  );
  t.diagnostic(`setup compose ps: ${describeComposePs(health.rows) || '(no containers)'}`);
  if (stack.error) {
    t.diagnostic(`blocked: ${stack.error}`);
  }

  await scenario(t, 'P1', 'product catalog', p1);
  await scenario(t, 'P2', 'order creation end to end', p2);
  await scenario(t, 'P3', 'inventory validation and no-op rejection', p3);
  await scenario(t, 'P4', 'order detail and status', p4);
  await scenario(t, 'P5', 'administrative transition to SHIPPED', p5);
  await scenario(t, 'P6', 'provider failure while the order survives', p6);
  await scenario(t, 'P7', 'no customer cancellation', p7);
  await scenario(t, 'P8', 'confirmation delivered once despite duplicate dispatches', p8);
  await scenario(t, 'P9', 'ambiguous failure, restart and stock exactness', p9);
  await scenario(t, 'P10', 'composed runtime readiness', p10);

  printTable(t);
});
