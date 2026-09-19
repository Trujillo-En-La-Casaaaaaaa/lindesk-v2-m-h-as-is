/**
 * ORD-U8 - compensation of a confirmed stock decrement whose local transaction cannot commit.
 *
 * The unit layer deliberately injects the failure through the unit-of-work double instead of a
 * broken database: what is under test is the saga's reaction (exactly one release, a terminal
 * compensated saga, no order row), not PostgreSQL's error handling. The same scenario is exercised
 * against the real database and the real inventory service in ORD-I6.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startUnitHarness } from '../../test-support/unit-harness.js';

const VALID_BODY = { productId: 'product-a', quantity: 3, customerEmail: 'buyer@example.com' };
const INTERNAL_ENVELOPE = { error: 'Internal server error' };

test('ORD-U8 a failing local commit after a confirmed decrement releases the stock exactly once and never creates an order', async (t) => {
  const harness = await startUnitHarness();
  t.after(() => harness.close());

  harness.unitOfWork.failNextCommitWith(new Error('terminating connection due to administrator command'));

  const response = await harness.post('/orders', VALID_BODY);

  assert.equal(response.status, 500, response.text);
  assert.deepEqual(response.body, INTERNAL_ENVELOPE);

  assert.equal(harness.inventory.decrementCalls.length, 1, 'the decrement was confirmed once');
  assert.equal(harness.inventory.releaseCalls.length, 1, 'exactly one compensating release');
  assert.equal(harness.inventory.releaseCalls[0]?.orderId, harness.inventory.decrementCalls[0]?.orderId);
  assert.equal(harness.store.orders.size, 0, 'no order row may survive a failed local transaction');
  assert.equal(harness.store.outbox.size, 0, 'no confirmation may be queued');
  assert.equal(harness.notifications.dispatches.length, 0);

  const operation = [...harness.store.operations.values()][0];
  assert.ok(operation);
  assert.equal(operation.state, 'DECREMENTED');
  assert.equal(operation.decrementOutcome, 'RELEASED', 'the compensated saga is terminal');
  assert.match(String(operation.lastError), /local commit failed/);
  assert.match(String(operation.lastError), /administrator command/);

  // A released saga is excluded from recovery: no second release, no replay, no order.
  await harness.recovery.recoverOnce();
  assert.equal(harness.inventory.releaseCalls.length, 1);
  assert.equal(harness.inventory.decrementCalls.length, 1);
  assert.equal(harness.store.orders.size, 0);

  // Without a client key the next request is a brand new saga (exactly the legacy behaviour): the
  // compensated saga is terminal and is never reused.
  const legacy = await harness.post('/orders', VALID_BODY);
  assert.equal(legacy.status, 201);
  assert.equal(harness.store.orders.size, 1);
  assert.equal(harness.store.operations.size, 2);
});

test('ORD-U8 when the compensating release cannot be confirmed the saga stays open and the worker retries it', async (t) => {
  const harness = await startUnitHarness();
  t.after(() => harness.close());

  harness.inventory.setReleaseHandler(() => ({ kind: 'UNAVAILABLE', detail: 'The operation was aborted' }));
  harness.unitOfWork.failNextCommitWith(new Error('the local commit failed'));

  const key = 'ORD-U8-release-pending';
  const response = await harness.post('/orders', VALID_BODY, { 'Idempotency-Key': key });
  assert.equal(response.status, 500);

  const operation = [...harness.store.operations.values()][0];
  assert.ok(operation);
  assert.equal(operation.state, 'DECREMENTED');
  assert.equal(operation.decrementOutcome, 'DECREMENTED', 'an unconfirmed release is not a compensation');
  assert.match(String(operation.lastError), /release is still pending/);
  assert.equal(harness.inventory.releaseCalls.length, 1);
  assert.equal(harness.store.orders.size, 0, 'never mark the saga complete without a successful release');

  // The worker retries: the commit fails again and this time the release is confirmed.
  harness.inventory.setReleaseHandler(() => ({ kind: 'RELEASED', releasedQuantity: 3 }));
  harness.unitOfWork.failNextCommitWith(new Error('the local commit failed again'));
  await harness.recovery.recoverOnce();

  const compensated = harness.store.operations.get(operation.orderId);
  assert.equal(compensated?.state, 'DECREMENTED');
  assert.equal(compensated?.decrementOutcome, 'RELEASED');
  assert.equal(harness.inventory.releaseCalls.length, 2);
  assert.equal(harness.inventory.decrementCalls.length, 1, 'the recorded decrement is never replayed for this order');
  assert.equal(harness.store.orders.size, 0);

  // Idempotent recovery: a further pass changes nothing at all.
  await harness.recovery.recoverOnce();
  assert.equal(harness.inventory.releaseCalls.length, 2);
  assert.equal(harness.inventory.decrementCalls.length, 1);
  assert.equal(harness.store.orders.size, 0);
  assert.equal(harness.store.outbox.size, 0);
});
