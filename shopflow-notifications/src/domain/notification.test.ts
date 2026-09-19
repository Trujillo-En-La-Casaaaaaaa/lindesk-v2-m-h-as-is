import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BACKOFF_CAP_MS,
  computeBackoffDelayMs,
  idempotencyKeyForOrderConfirmation,
  parseOrderConfirmationIntent,
  toNotificationView,
  type NotificationRecord,
} from './notification.js';

describe('notification domain', () => {
  it('validates order-confirmation intents', () => {
    const parsed = parseOrderConfirmationIntent({
      type: 'ORDER_CONFIRMATION',
      orderId: '6f1c',
      customerEmail: 'buyer@example.com',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.deepEqual(parsed.intent, {
        type: 'ORDER_CONFIRMATION',
        orderId: '6f1c',
        customerEmail: 'buyer@example.com',
        occurredAt: new Date('2026-01-01T00:00:00.000Z'),
      });
    }

    const withoutOccurredAt = parseOrderConfirmationIntent({
      type: 'ORDER_CONFIRMATION',
      orderId: '6f1c',
      customerEmail: 'buyer@example.com',
    });
    assert.equal(withoutOccurredAt.ok, true);
    if (withoutOccurredAt.ok) {
      assert.equal(withoutOccurredAt.intent.occurredAt, null);
    }

    assert.equal(parseOrderConfirmationIntent(null).ok, false);
    assert.equal(parseOrderConfirmationIntent([]).ok, false);
    assert.equal(parseOrderConfirmationIntent({ type: 'ORDER_CONFIRMATION', orderId: 'x', customerEmail: 'buyer@example.com', occurredAt: 'yesterday' }).ok, false);
  });

  it('formats the required idempotency key', () => {
    assert.equal(idempotencyKeyForOrderConfirmation('6f1c'), 'ORDER_CONFIRMATION:6f1c');
  });

  it('exposes exactly the documented notification fields', () => {
    const record: NotificationRecord = {
      id: 'ntf-0001',
      type: 'ORDER_CONFIRMATION',
      orderId: '6f1c',
      customerEmail: 'buyer@example.com',
      status: 'DELIVERED',
      attempts: 1,
      nextAttemptAt: null,
      providerRecordId: 'notification-0001',
      occurredAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    const view = toNotificationView(record);
    assert.deepEqual(Object.keys(view).sort(), [
      'attempts',
      'createdAt',
      'customerEmail',
      'id',
      'orderId',
      'providerRecordId',
      'status',
      'type',
    ]);
    assert.equal(view.createdAt, '2026-01-01T00:00:00.000Z');
    assert.equal(view.type, 'ORDER_CONFIRMATION');
  });

  it('computes bounded exponential backoff', () => {
    assert.equal(computeBackoffDelayMs(1, 250), 250);
    assert.equal(computeBackoffDelayMs(2, 250), 500);
    assert.equal(computeBackoffDelayMs(3, 250), 1000);
    assert.equal(computeBackoffDelayMs(7, 250), 16000);
    assert.equal(computeBackoffDelayMs(8, 250), BACKOFF_CAP_MS);
    assert.equal(computeBackoffDelayMs(9, 250), BACKOFF_CAP_MS);
    assert.equal(computeBackoffDelayMs(50, 250), BACKOFF_CAP_MS);
    assert.equal(computeBackoffDelayMs(0, 250), 250);
  });
});
