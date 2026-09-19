import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HttpNotificationProvider } from '../adapters/provider/http-notification-provider.js';
import { NotificationDeliveryService } from '../application/notification-delivery-service.js';
import type { OrderConfirmationIntent } from '../domain/notification.js';
import { silentLogger } from '../observability/logger.js';
import { InMemoryNotificationRepository } from '../test-support/in-memory-notification-repository.js';
import { StubNotificationProvider } from '../test-support/provider-stub.js';
import { DeliveryWorker } from './delivery-worker.js';

const INTENT: OrderConfirmationIntent = {
  type: 'ORDER_CONFIRMATION',
  orderId: 'order-u14',
  customerEmail: 'buyer@example.com',
  occurredAt: null,
};

describe('delivery worker - unit tests', () => {
  it('NOTIF-U14 delivers a due record on one tick and honours the backoff schedule', async () => {
    const providerStub = new StubNotificationProvider();
    await providerStub.start();
    const repository = new InMemoryNotificationRepository();
    let now = new Date('2026-01-01T00:00:00.000Z');

    const delivery = new NotificationDeliveryService({
      repository,
      provider: new HttpNotificationProvider({ baseUrl: providerStub.baseUrl, timeoutMs: 3000 }),
      backoffBaseMs: 250,
      logger: silentLogger,
      now: () => now,
    });
    const worker = new DeliveryWorker(delivery, { intervalMs: 60_000, logger: silentLogger });

    try {
      // Recovery of a committed PENDING record (the crash window between persisting
      // the record and calling the provider).
      const { record } = await repository.beginDeliveryForIntent(INTENT);
      assert.equal(record.status, 'PENDING');
      assert.equal(worker.isRunning, false, 'the worker loop must not run unless it is started');

      assert.equal(await worker.tick(), 1);
      const delivered = await repository.findById(record.id);
      assert.equal(delivered?.status, 'DELIVERED');
      assert.equal(delivered?.providerRecordId, 'notification-0001');
      assert.equal(providerStub.postCount, 1);
      assert.equal(providerStub.notificationsForOrder(INTENT.orderId).length, 1);

      // A failure schedules the next attempt; the following tick only fires once
      // the backoff elapsed (the clock is advanced instead of sleeping).
      const secondIntent: OrderConfirmationIntent = { ...INTENT, orderId: 'order-u14b' };
      const { record: secondRecord } = await repository.beginDeliveryForIntent(secondIntent);
      providerStub.setFailNextRequests(1);

      assert.equal(await worker.tick(), 0);
      const failed = await repository.findById(secondRecord.id);
      assert.equal(failed?.status, 'PENDING');
      assert.equal(failed?.attempts, 1);
      const scheduledAt = failed?.nextAttemptAt?.getTime() ?? 0;
      assert.equal(scheduledAt - now.getTime(), 250);

      assert.equal(await worker.tick(), 0, 'a record that is still backing off must not be retried');
      now = new Date(scheduledAt);
      assert.equal(await worker.tick(), 1);

      const recovered = await repository.findById(secondRecord.id);
      assert.equal(recovered?.status, 'DELIVERED');
      assert.equal(providerStub.notificationsForOrder('order-u14b').length, 1);
    } finally {
      await providerStub.stop();
    }
  });
});
