import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_INVENTORY_URL,
  DEFAULT_ORDERS_URL,
  DEFAULT_PORT,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  loadConfig,
} from './config.js';

describe('gateway configuration', () => {
  it('applies the documented defaults when the environment is empty', () => {
    const config = loadConfig({});

    assert.deepEqual(config, {
      port: DEFAULT_PORT,
      ordersUrl: DEFAULT_ORDERS_URL,
      inventoryUrl: DEFAULT_INVENTORY_URL,
      upstreamTimeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS,
    });
    assert.equal(config.port, 3001);
    assert.equal(config.ordersUrl, 'http://orders:3002');
    assert.equal(config.inventoryUrl, 'http://inventory:3003');
    assert.equal(config.upstreamTimeoutMs, 5000);
  });

  it('reads PORT, ORDERS_URL, INVENTORY_URL and UPSTREAM_TIMEOUT_MS and normalises trailing slashes', () => {
    const config = loadConfig({
      PORT: '3100',
      ORDERS_URL: 'http://orders:3002/',
      INVENTORY_URL: 'http://inventory:3003///',
      UPSTREAM_TIMEOUT_MS: '1500',
    });

    assert.deepEqual(config, {
      port: 3100,
      ordersUrl: 'http://orders:3002',
      inventoryUrl: 'http://inventory:3003',
      upstreamTimeoutMs: 1500,
    });
  });

  it('rejects values that would make the edge misbehave', () => {
    assert.throws(() => loadConfig({ PORT: 'not-a-port' }), /PORT/);
    assert.throws(() => loadConfig({ PORT: '0' }), /PORT/);
    assert.throws(() => loadConfig({ UPSTREAM_TIMEOUT_MS: '0' }), /UPSTREAM_TIMEOUT_MS/);
    assert.throws(() => loadConfig({ ORDERS_URL: 'orders:3002' }), /ORDERS_URL/);
    assert.throws(() => loadConfig({ INVENTORY_URL: 'ftp://inventory:3003' }), /INVENTORY_URL/);
  });

  it('exposes exactly the four documented settings and no database configuration', () => {
    assert.deepEqual(Object.keys(loadConfig({})).sort(), [
      'inventoryUrl',
      'ordersUrl',
      'port',
      'upstreamTimeoutMs',
    ]);
  });
});
