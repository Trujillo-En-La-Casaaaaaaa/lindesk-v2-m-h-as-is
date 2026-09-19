import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withHarness } from '../../testing/gateway-harness.js';
import { CREATE_ORDER_REQUEST_BODY, ORDER_ID, PRODUCTS_BODY, UNAVAILABLE_BODY } from '../../testing/legacy-fixtures.js';
import { reserveClosedPort, startDroppingServer, startStubServer } from '../../testing/upstream-stub.js';

describe('gateway resilience against the owning services', () => {
  it('GW-U7 an unreachable inventory service yields the exact 503 envelope and a logged upstream + correlation id', async () => {
    const closedPort = await reserveClosedPort();

    await withHarness(
      { inventoryUrl: `http://127.0.0.1:${closedPort}`, upstreamTimeoutMs: 1000 },
      async (harness) => {
        const response = await fetch(`${harness.gatewayUrl}/products`, {
          headers: { 'x-correlation-id': 'corr-transport-1' },
        });

        assert.equal(response.status, 503);
        assert.equal(await response.text(), UNAVAILABLE_BODY);
        assert.match(response.headers.get('content-type') ?? '', /application\/json/);
        assert.equal(response.headers.get('x-correlation-id'), 'corr-transport-1');

        const failures = harness.logger.entries.filter((entry) => entry.level === 'error');
        assert.equal(failures.length, 1);
        assert.equal(failures[0].fields.upstream, 'inventory');
        assert.equal(failures[0].fields.correlationId, 'corr-transport-1');
      },
    );
  });

  it('GW-U7 an unreachable orders service yields the same 503 envelope for a write', async () => {
    const closedPort = await reserveClosedPort();

    await withHarness({ ordersUrl: `http://127.0.0.1:${closedPort}`, upstreamTimeoutMs: 1000 }, async (harness) => {
      const response = await fetch(`${harness.gatewayUrl}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: CREATE_ORDER_REQUEST_BODY,
      });

      assert.equal(response.status, 503);
      assert.equal(await response.text(), UNAVAILABLE_BODY);

      const failures = harness.logger.entries.filter((entry) => entry.level === 'error');
      assert.equal(failures.length, 1);
      assert.equal(failures[0].fields.upstream, 'orders');
      assert.ok(failures[0].fields.correlationId);
    });
  });

  it('GW-U8 never retries a POST and retries a connection-failed GET exactly once', async () => {
    const dropping = await startDroppingServer();

    try {
      await withHarness(
        { ordersUrl: dropping.url, inventoryUrl: dropping.url, upstreamTimeoutMs: 2000 },
        async (harness) => {
          const created = await fetch(`${harness.gatewayUrl}/orders`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: CREATE_ORDER_REQUEST_BODY,
          });
          assert.equal(created.status, 503);
          assert.equal(await created.text(), UNAVAILABLE_BODY);
          assert.equal(dropping.attempts(), 1, 'POST /orders must be attempted exactly once');

          dropping.resetAttempts();
          const shipped = await fetch(`${harness.gatewayUrl}/admin/orders/${ORDER_ID}/ship`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          assert.equal(shipped.status, 503);
          assert.equal(dropping.attempts(), 1, 'POST /admin/orders/:id/ship must be attempted exactly once');

          dropping.resetAttempts();
          const products = await fetch(`${harness.gatewayUrl}/products`);
          assert.equal(products.status, 503);
          assert.equal(await products.text(), UNAVAILABLE_BODY);
          assert.equal(dropping.attempts(), 2, 'a connection-failed GET may be retried once');

          dropping.resetAttempts();
          const detail = await fetch(`${harness.gatewayUrl}/orders/${ORDER_ID}`);
          assert.equal(detail.status, 503);
          assert.equal(dropping.attempts(), 2, 'a connection-failed GET may be retried once');
        },
      );
    } finally {
      await dropping.close();
    }
  });

  it('bounds a hanging POST with UPSTREAM_TIMEOUT_MS and does not retry it', async () => {
    const hangingOrders = await startStubServer(() => new Promise<never>(() => {}));

    try {
      const timeoutMs = 150;
      await withHarness({ ordersUrl: hangingOrders.url, upstreamTimeoutMs: timeoutMs }, async (harness) => {
        const startedAt = Date.now();
        const response = await fetch(`${harness.gatewayUrl}/orders`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: CREATE_ORDER_REQUEST_BODY,
        });
        const elapsedMs = Date.now() - startedAt;

        assert.equal(response.status, 503);
        assert.equal(await response.text(), UNAVAILABLE_BODY);
        assert.equal(hangingOrders.requests.length, 1);
        assert.ok(elapsedMs >= timeoutMs, `the configured timeout must be applied (elapsed ${elapsedMs} ms)`);
        assert.ok(elapsedMs < timeoutMs + 2000, `the attempt must stay bounded (elapsed ${elapsedMs} ms)`);
      });
    } finally {
      await hangingOrders.close();
    }
  });

  it('bounds a hanging GET with UPSTREAM_TIMEOUT_MS, retries only connection failures', async () => {
    const hangingInventory = await startStubServer(() => new Promise<never>(() => {}));

    try {
      const timeoutMs = 150;
      await withHarness({ inventoryUrl: hangingInventory.url, upstreamTimeoutMs: timeoutMs }, async (harness) => {
        const startedAt = Date.now();
        const response = await fetch(`${harness.gatewayUrl}/products`);
        const elapsedMs = Date.now() - startedAt;

        assert.equal(response.status, 503);
        assert.equal(await response.text(), UNAVAILABLE_BODY);
        assert.equal(hangingInventory.requests.length, 1, 'a timed-out read is not retried');
        assert.ok(elapsedMs < timeoutMs + 2000, `the attempt must stay bounded (elapsed ${elapsedMs} ms)`);
      });
    } finally {
      await hangingInventory.close();
    }
  });

  it('keeps serving successful reads and forwards an upstream 503 body verbatim instead of the gateway envelope', async () => {
    const upstreamOwnBody = '{"error":"Inventory maintenance window","code":"UNAVAILABLE"}';

    await withHarness({}, async (harness) => {
      const healthy = await fetch(`${harness.gatewayUrl}/products`);
      assert.equal(healthy.status, 200);
      assert.equal(await healthy.text(), PRODUCTS_BODY);

      harness.inventory.respond(() => ({ status: 503, body: upstreamOwnBody }));

      const degraded = await fetch(`${harness.gatewayUrl}/products`);
      assert.equal(degraded.status, 503);
      assert.equal(
        await degraded.text(),
        upstreamOwnBody,
        'an upstream 503 body is passed through, never replaced by the gateway envelope',
      );
      assert.notEqual(await Promise.resolve(UNAVAILABLE_BODY), upstreamOwnBody);
    });
  });
});
