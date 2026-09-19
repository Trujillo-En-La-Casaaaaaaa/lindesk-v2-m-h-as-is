import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DecrementAlreadyReleasedError,
  DecrementNotReleasableError,
  InsufficientStockError,
  InvalidStockDecrementRequestError,
  NoStockDecrementRecordedError,
  ProductNotFoundError,
} from '../domain/errors.js';
import { InMemoryInventory } from '../test-support/in-memory-inventory.js';
import { parseStockDecrementRequest, type StockDecrementRequest } from './stock-decrement-request.js';
import { StockService } from './stock-service.js';

/**
 * `INV-U*` - the stock rules of the service, without a database.
 *
 * The ports are replaced by `InMemoryInventory`, which mirrors the SQL semantics: a guarded update
 * that refuses to go below zero, one ledger row per order id and a guarded release that can only
 * match a `RECORDED` decrement. Every test asserts that a replay changes neither the stock nor the
 * ledger (the doubles count both writes).
 */

const ORDER_ONE = '6f1c1d38-6a1e-4f6f-9d3f-2d8a9f0f8c11';
const ORDER_TWO = '0f2e2c48-7b2f-4a70-8e40-3e9b0a1f9d22';
const ORDER_THREE = 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d';
const UNKNOWN_ORDER = '00000000-0000-4000-8000-000000000000';

function requestOf(orderId: string, productId: string, quantity: number): StockDecrementRequest {
  return { orderId, productId, quantity };
}

test('INV-U1 rejects every malformed decrement request with the documented INVALID failure', () => {
  const valid = { orderId: ORDER_ONE, productId: 'product-a', quantity: 3 };
  const rejected: Array<[string, unknown, unknown]> = [
    ['missing idempotency key', undefined, valid],
    ['empty idempotency key', '', valid],
    ['non-string idempotency key', 7, valid],
    ['body order id differs from the header', ORDER_TWO, valid],
    ['body order id is missing', ORDER_ONE, { productId: 'product-a', quantity: 3 }],
    ['order id is not a UUID', 'order-1', { orderId: 'order-1', productId: 'product-a', quantity: 1 }],
    ['product id is missing', ORDER_ONE, { orderId: ORDER_ONE, quantity: 1 }],
    ['product id is blank', ORDER_ONE, { orderId: ORDER_ONE, productId: '   ', quantity: 1 }],
    ['quantity is zero', ORDER_ONE, { orderId: ORDER_ONE, productId: 'product-a', quantity: 0 }],
    ['quantity is negative', ORDER_ONE, { orderId: ORDER_ONE, productId: 'product-a', quantity: -2 }],
    ['quantity is fractional', ORDER_ONE, { orderId: ORDER_ONE, productId: 'product-a', quantity: 1.5 }],
    ['quantity is a string', ORDER_ONE, { orderId: ORDER_ONE, productId: 'product-a', quantity: '3' }],
    ['quantity is missing', ORDER_ONE, { orderId: ORDER_ONE, productId: 'product-a' }],
    ['body is not an object', ORDER_ONE, 'product-a'],
    ['body is empty', ORDER_ONE, undefined],
  ];

  for (const [label, idempotencyKey, body] of rejected) {
    assert.throws(
      () => parseStockDecrementRequest(idempotencyKey, body),
      (error: unknown) => {
        assert.ok(error instanceof InvalidStockDecrementRequestError, `${label}: expected INVALID`);
        assert.equal(error.status, 400, label);
        assert.equal(error.code, 'INVALID', label);
        assert.equal(error.message, 'A product id and a positive whole quantity are required', label);
        return true;
      },
      label,
    );
  }

  assert.deepEqual(parseStockDecrementRequest(ORDER_ONE, valid), {
    orderId: ORDER_ONE,
    productId: 'product-a',
    quantity: 3,
  });
});

test('INV-U2 insufficient stock is recorded as an outcome and changes nothing', async () => {
  const inventory = new InMemoryInventory();
  const service = new StockService(inventory);

  const outcome = await service.decrementStock(requestOf(ORDER_ONE, 'product-b', 6));

  assert.equal(outcome.record.outcome, 'INSUFFICIENT_STOCK');
  assert.equal(outcome.replayed, false);
  assert.equal(outcome.record.state, 'RECORDED');
  assert.equal(outcome.record.unitPriceCents, null);
  assert.equal(outcome.record.totalCents, null);
  assert.equal(outcome.record.remainingStock, null);
  assert.equal(inventory.stockOf('product-b'), 5, 'the stock must not change');
  assert.equal(inventory.stockUpdates, 0, 'no guarded update may be applied');
  assert.equal(inventory.ledgerSize(), 1, 'the rejected outcome must still be recorded');
  assert.deepEqual(inventory.recordedOutcomes(), ['INSUFFICIENT_STOCK']);

  const replay = await service.decrementStock(requestOf(ORDER_ONE, 'product-b', 6));
  assert.equal(replay.replayed, true);
  assert.equal(replay.record.outcome, 'INSUFFICIENT_STOCK');
  assert.equal(inventory.stockOf('product-b'), 5);
  assert.equal(inventory.stockUpdates, 0);
  assert.equal(inventory.ledgerWrites, 1);
});

test('INV-U3 a recorded decrement replays the stored numbers and does not mutate again', async () => {
  const inventory = new InMemoryInventory();
  const service = new StockService(inventory);

  const first = await service.decrementStock(requestOf(ORDER_ONE, 'product-a', 3));
  assert.equal(first.replayed, false);
  assert.equal(first.record.outcome, 'DECREMENTED');
  assert.equal(first.record.unitPriceCents, 1200);
  assert.equal(first.record.totalCents, 3600);
  assert.equal(first.record.remainingStock, 7);
  assert.equal(inventory.stockOf('product-a'), 7);

  const stockUpdates = inventory.stockUpdates;
  const ledgerWrites = inventory.ledgerWrites;

  const replay = await service.decrementStock(requestOf(ORDER_ONE, 'product-a', 3));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.record, first.record, 'the recorded outcome is replayed unchanged');
  assert.equal(inventory.stockOf('product-a'), 7, 'the replay must not decrement again');
  assert.equal(inventory.stockUpdates, stockUpdates, 'the replay must not run a guarded update');
  assert.equal(inventory.ledgerWrites, ledgerWrites, 'the replay must not write a ledger row');
  assert.equal(inventory.ledgerSize(), 1);
});

test('INV-U3 an unknown product is recorded as NOT_FOUND and replayed identically', async () => {
  const inventory = new InMemoryInventory();
  const service = new StockService(inventory);

  const first = await service.decrementStock(requestOf(ORDER_TWO, 'product-unknown', 1));
  assert.equal(first.record.outcome, 'NOT_FOUND');
  assert.equal(first.replayed, false);
  assert.equal(inventory.ledgerSize(), 1);
  assert.equal(inventory.stockUpdates, 0);

  const replay = await service.decrementStock(requestOf(ORDER_TWO, 'product-unknown', 1));
  assert.equal(replay.replayed, true);
  assert.equal(replay.record.outcome, 'NOT_FOUND');
  assert.equal(inventory.stockOf('product-a'), 10);
  assert.equal(inventory.stockOf('product-b'), 5);
  assert.equal(inventory.ledgerWrites, 1);
});

test('INV-U4 releasing a DECREMENTED row restores the stock exactly once', async () => {
  const inventory = new InMemoryInventory();
  const service = new StockService(inventory);

  await service.decrementStock(requestOf(ORDER_ONE, 'product-a', 3));
  assert.equal(inventory.stockOf('product-a'), 7);

  const release = await service.releaseStock(ORDER_ONE);
  assert.deepEqual(release, {
    orderId: ORDER_ONE,
    releasedQuantity: 3,
    remainingStock: 10,
    replayed: false,
  });
  assert.equal(inventory.stockOf('product-a'), 10);
  assert.equal(inventory.ledgerEntry(ORDER_ONE)?.state, 'RELEASED');

  const ledgerWrites = inventory.ledgerWrites;
  const replay = await service.releaseStock(ORDER_ONE);
  assert.deepEqual(replay, {
    orderId: ORDER_ONE,
    releasedQuantity: 3,
    remainingStock: 10,
    replayed: true,
  });
  assert.equal(inventory.stockOf('product-a'), 10, 'a repeated release must not increment again');
  assert.equal(inventory.ledgerWrites, ledgerWrites, 'a repeated release must not write again');
});

test('INV-U5 releasing a row whose outcome is not DECREMENTED is a STATE_CONFLICT', async () => {
  const inventory = new InMemoryInventory();
  const service = new StockService(inventory);

  await service.decrementStock(requestOf(ORDER_ONE, 'product-b', 6));
  await service.decrementStock(requestOf(ORDER_TWO, 'product-unknown', 1));
  const ledgerWrites = inventory.ledgerWrites;

  for (const orderId of [ORDER_ONE, ORDER_TWO]) {
    await assert.rejects(
      () => service.releaseStock(orderId),
      (error: unknown) => {
        assert.ok(error instanceof DecrementNotReleasableError);
        assert.equal(error.status, 409);
        assert.equal(error.code, 'STATE_CONFLICT');
        assert.equal(error.message, 'Only a completed decrement can be released');
        return true;
      },
    );
    assert.equal(inventory.ledgerEntry(orderId)?.state, 'RECORDED', 'the rejected release must not change state');
  }

  assert.equal(inventory.stockOf('product-b'), 5);
  assert.equal(inventory.ledgerWrites, ledgerWrites);
});

test('INV-U6 releasing an order id with no recorded decrement is a 404 and records nothing', async () => {
  const inventory = new InMemoryInventory();
  const service = new StockService(inventory);

  for (const orderId of [UNKNOWN_ORDER, 'not-a-uuid', '']) {
    await assert.rejects(
      () => service.releaseStock(orderId),
      (error: unknown) => {
        assert.ok(error instanceof NoStockDecrementRecordedError);
        assert.equal(error.status, 404);
        assert.equal(error.code, 'NOT_FOUND');
        assert.equal(error.message, 'No stock decrement recorded for this order');
        return true;
      },
      orderId,
    );
  }

  assert.equal(inventory.ledgerSize(), 0, 'a release must never create a ledger row');
  assert.equal(inventory.ledgerWrites, 0);
});

test('INV-U7 a decrement whose ledger row was released is a STATE_CONFLICT', async () => {
  const inventory = new InMemoryInventory();
  const service = new StockService(inventory);

  await service.decrementStock(requestOf(ORDER_THREE, 'product-a', 4));
  await service.releaseStock(ORDER_THREE);
  const stockUpdates = inventory.stockUpdates;

  await assert.rejects(
    () => service.decrementStock(requestOf(ORDER_THREE, 'product-a', 4)),
    (error: unknown) => {
      assert.ok(error instanceof DecrementAlreadyReleasedError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'STATE_CONFLICT');
      assert.equal(error.message, 'The decrement for this order was already released');
      return true;
    },
  );

  assert.equal(inventory.stockOf('product-a'), 10, 'the rejected repeat must not change stock');
  assert.equal(inventory.stockUpdates, stockUpdates);
  assert.equal(inventory.rollbacks, 1, 'the failed use case must roll its transaction back');
});

test('INV-U8 the domain errors serialize to the documented envelopes', () => {
  const envelopes = [
    [new InvalidStockDecrementRequestError(), 400, { error: 'A product id and a positive whole quantity are required', code: 'INVALID' }],
    [new ProductNotFoundError(), 404, { error: 'Product not found', code: 'NOT_FOUND' }],
    [new InsufficientStockError(), 409, { error: 'Insufficient stock', code: 'INSUFFICIENT_STOCK' }],
    [new DecrementAlreadyReleasedError(), 409, { error: 'The decrement for this order was already released', code: 'STATE_CONFLICT' }],
    [new NoStockDecrementRecordedError(), 404, { error: 'No stock decrement recorded for this order', code: 'NOT_FOUND' }],
    [new DecrementNotReleasableError(), 409, { error: 'Only a completed decrement can be released', code: 'STATE_CONFLICT' }],
  ] as const;

  for (const [error, status, envelope] of envelopes) {
    assert.equal(error.status, status);
    assert.deepEqual({ error: error.message, code: error.code }, envelope);
    assert.deepEqual(Object.keys({ error: error.message, code: error.code }).sort(), ['code', 'error']);
  }
});
