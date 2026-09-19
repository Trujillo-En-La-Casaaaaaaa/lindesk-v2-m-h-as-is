import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HttpNotificationProvider } from '../adapters/provider/http-notification-provider.js';
import type { OrderConfirmationIntent } from '../domain/notification.js';
import { silentLogger } from '../observability/logger.js';
import {
  ProviderError,
  type NotificationProvider,
  type ProviderAcceptance,
  type ProviderNotificationRecord,
  type ProviderOrderConfirmationPayload,
} from '../ports/notification-provider.js';
import { InMemoryNotificationRepository } from '../test-support/in-memory-notification-repository.js';
import { StubNotificationProvider } from '../test-support/provider-stub.js';
import { NotificationDeliveryService } from './notification-delivery-service.js';

class FailingProvider implements NotificationProvider {
  calls = 0;
  readonly payloads: ProviderOrderConfirmationPayload[] = [];

  async sendOrderConfirmation(payload: ProviderOrderConfirmationPayload): Promise<ProviderAcceptance> {
    this.calls += 1;
    this.payloads.push(payload);
    throw new ProviderError('PROVIDER_ERROR', 'provider responded 503');
  }

  async listNotifications(): Promise<ProviderNotificationRecord[]> {
    return [];
  }
}

const INTENT: OrderConfirmationIntent = {
  type: 'ORDER_CONFIRMATION',
  orderId: 'order-u7',
  customerEmail: 'buyer@example.com',
  occurredAt: null,
};

describe('notification delivery service - unit tests', () => {
  it('NOTIF-U7 schedules bounded exponential backoff (base 250 ms, cap 30 s) after each failure', async () => {
    const repository = new InMemoryNotificationRepository();
    const provider = new FailingProvider();
    let now = new Date('2026-01-01T00:00:00.000Z');

    const delivery = new NotificationDeliveryService({
      repository,
      provider,
      backoffBaseMs: 250,
      logger: silentLogger,
      now: () => now,
    });

    const expectedDelaysMs = [250, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000];

    for (const [index, expectedDelay] of expectedDelaysMs.entries()) {
      const outcome = await delivery.dispatchOrderConfirmation(INTENT);
      const attempt = index + 1;

      assert.equal(outcome.kind, 'provider-failure');
      assert.equal(outcome.record.status, 'PENDING');
      assert.equal(outcome.record.attempts, attempt);
      assert.ok(outcome.record.nextAttemptAt instanceof Date);
      assert.equal(
        (outcome.record.nextAttemptAt as Date).getTime() - now.getTime(),
        expectedDelay,
        `attempt ${attempt} must back off by ${expectedDelay} ms`,
      );

      // Let the scheduled backoff elapse before the next dispatch.
      now = new Date(now.getTime() + expectedDelay);
    }

    assert.equal(provider.calls, expectedDelaysMs.length);
    assert.equal(repository.attemptsFor('ntf-0001').length, expectedDelaysMs.length);
    assert.equal(repository.attemptsFor('ntf-0001').every((attempt) => attempt.outcome === 'PROVIDER_ERROR'), true);
  });

  it('NOTIF-U17 stops retrying once DELIVERY_MAX_ATTEMPTS is reached', async () => {
    const repository = new InMemoryNotificationRepository();
    const provider = new FailingProvider();
    let now = new Date('2026-01-01T00:00:00.000Z');

    const delivery = new NotificationDeliveryService({
      repository,
      provider,
      backoffBaseMs: 10,
      maxAttempts: 1,
      logger: silentLogger,
      now: () => now,
    });

    const first = await delivery.dispatchOrderConfirmation(INTENT);
    assert.equal(first.kind, 'provider-failure');
    assert.equal(first.record.attempts, 1);

    now = new Date(now.getTime() + 60_000);
    const processed = await delivery.processDueDeliveries();
    assert.equal(processed, 0);
    assert.equal(provider.calls, 1);

    const record = await repository.findById(first.record.id);
    assert.equal(record?.status, 'PENDING');
    assert.equal(record?.attempts, 1);
  });

  it('NOTIF-U18 reconciles a worker retry against the provider inspection endpoint instead of posting twice', async () => {
    const providerStub = new StubNotificationProvider();
    await providerStub.start();
    const repository = new InMemoryNotificationRepository();
    let now = new Date('2026-01-01T00:00:00.000Z');

    const delivery = new NotificationDeliveryService({
      repository,
      provider: new HttpNotificationProvider({ baseUrl: providerStub.baseUrl, timeoutMs: 3000 }),
      backoffBaseMs: 10,
      logger: silentLogger,
      now: () => now,
    });

    try {
      providerStub.setFailNextRequests(1);
      const failed = await delivery.dispatchOrderConfirmation(INTENT);
      assert.equal(failed.kind, 'provider-failure');
      assert.equal(providerStub.postCount, 1);

      // The provider accepted the message but the response was lost.
      const providerRecord = providerStub.seedNotification({ orderId: INTENT.orderId });

      now = new Date(now.getTime() + 50);
      const delivered = await delivery.processDueDeliveries();

      assert.equal(delivered, 1);
      assert.equal(providerStub.postCount, 1);
      assert.equal(providerStub.notificationsForOrder(INTENT.orderId).length, 1);

      const record = await repository.findById(failed.record.id);
      assert.equal(record?.status, 'DELIVERED');
      assert.equal(record?.providerRecordId, providerRecord.id);
      assert.equal(
        repository.attemptsFor(failed.record.id).map((attempt) => attempt.outcome).join(','),
        'PROVIDER_ERROR,RECONCILED',
      );
    } finally {
      await providerStub.stop();
    }
  });
});
