import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONFIG_DEFAULTS, ConfigurationError, loadConfig } from './config.js';

describe('configuration', () => {
  it('NOTIF-U16 exposes the documented defaults, reads overrides and rejects invalid values', () => {
    const defaults = loadConfig({});

    assert.deepEqual(defaults, {
      port: 3004,
      databaseUrl: 'postgresql://postgres:postgres@localhost:5432/notifications',
      providerUrl: 'http://localhost:4010',
      providerTimeoutMs: 3000,
      deliveryIntervalMs: 1000,
      deliveryBackoffBaseMs: 250,
      deliveryMaxAttempts: 0,
      deliveryWorkerEnabled: true,
    });

    // The legacy 3 s provider timeout is the configured default.
    assert.equal(CONFIG_DEFAULTS.providerTimeoutMs, 3000);
    assert.equal(defaults.deliveryWorkerEnabled, true);
    assert.equal(defaults.deliveryMaxAttempts, 0, '0 means unlimited attempts');

    const overridden = loadConfig({
      PORT: '8080',
      NOTIFICATIONS_DATABASE_URL: 'postgresql://notifications-db:5432/notifications',
      PROVIDER_URL: 'http://provider:4010',
      PROVIDER_TIMEOUT_MS: '1500',
      DELIVERY_INTERVAL_MS: '250',
      DELIVERY_BACKOFF_BASE_MS: '50',
      DELIVERY_MAX_ATTEMPTS: '5',
      DELIVERY_WORKER_ENABLED: 'false',
    });

    assert.equal(overridden.port, 8080);
    assert.equal(overridden.databaseUrl, 'postgresql://notifications-db:5432/notifications');
    assert.equal(overridden.providerUrl, 'http://provider:4010');
    assert.equal(overridden.providerTimeoutMs, 1500);
    assert.equal(overridden.deliveryIntervalMs, 250);
    assert.equal(overridden.deliveryBackoffBaseMs, 50);
    assert.equal(overridden.deliveryMaxAttempts, 5);
    assert.equal(overridden.deliveryWorkerEnabled, false);

    assert.throws(() => loadConfig({ PORT: 'not-a-port' }), ConfigurationError);
    assert.throws(() => loadConfig({ PROVIDER_TIMEOUT_MS: '-1' }), /PROVIDER_TIMEOUT_MS must be an integer/);
    assert.throws(() => loadConfig({ DELIVERY_WORKER_ENABLED: 'maybe' }), /must be a boolean/);
  });
});
