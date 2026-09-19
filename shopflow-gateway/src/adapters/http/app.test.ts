import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withHarness } from '../../testing/gateway-harness.js';
import {
  CREATE_ORDER_REQUEST_BODY,
  ERROR_EXHAUSTED_STOCK_BODY,
  ERROR_INTERNAL_BODY,
  ERROR_INVALID_BODY,
  ERROR_INVALID_STATUS_BODY,
  ERROR_ORDER_NOT_FOUND_BODY,
  ERROR_PRODUCT_NOT_FOUND_BODY,
  HEALTH_BODY,
  ORDER_ID,
  PRODUCTS_BODY,
  createdOrderBody,
  shippedOrderBody,
} from '../../testing/legacy-fixtures.js';
import { ROUTE_TABLE } from '../../routes/table.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ErrorCase {
  readonly label: string;
  readonly request: { readonly method: string; readonly path: string; readonly body?: string };
  readonly upstream: { readonly status: number; readonly body: string };
}

const errorCases: readonly ErrorCase[] = [
  {
    label: '400 INVALID on create order',
    request: { method: 'POST', path: '/orders', body: CREATE_ORDER_REQUEST_BODY },
    upstream: { status: 400, body: ERROR_INVALID_BODY },
  },
  {
    label: '400 stock-exhausted code on create order',
    request: { method: 'POST', path: '/orders', body: CREATE_ORDER_REQUEST_BODY },
    upstream: { status: 400, body: ERROR_EXHAUSTED_STOCK_BODY },
  },
  {
    label: '404 product not found on create order',
    request: { method: 'POST', path: '/orders', body: CREATE_ORDER_REQUEST_BODY },
    upstream: { status: 404, body: ERROR_PRODUCT_NOT_FOUND_BODY },
  },
  {
    label: '404 order not found on order detail',
    request: { method: 'GET', path: `/orders/${ORDER_ID}` },
    upstream: { status: 404, body: ERROR_ORDER_NOT_FOUND_BODY },
  },
  {
    label: '409 INVALID_STATUS on ship',
    request: { method: 'POST', path: `/admin/orders/${ORDER_ID}/ship`, body: '{}' },
    upstream: { status: 409, body: ERROR_INVALID_STATUS_BODY },
  },
  {
    label: '500 single-field envelope on ship',
    request: { method: 'POST', path: `/admin/orders/${ORDER_ID}/ship`, body: '{}' },
    upstream: { status: 500, body: ERROR_INTERNAL_BODY },
  },
];

describe('shopflow-gateway public edge', () => {
  it('GW-U1 GET /health answers {"ok":true} without calling any upstream', async () => {
    await withHarness({}, async (harness) => {
      const response = await fetch(`${harness.gatewayUrl}/health`);

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      assert.equal(await response.text(), HEALTH_BODY);
      assert.equal(harness.orders.requests.length, 0);
      assert.equal(harness.inventory.requests.length, 0);
    });
  });

  it('GW-U2 GET /products returns the inventory status and body byte-identically from an unprefixed path', async () => {
    await withHarness({}, async (harness) => {
      const response = await fetch(`${harness.gatewayUrl}/products`);

      assert.equal(response.status, 200);
      assert.equal(await response.text(), PRODUCTS_BODY);
      assert.equal(harness.inventory.requests.length, 1);
      assert.equal(harness.orders.requests.length, 0);

      const upstreamRequest = harness.inventory.requests[0];
      assert.equal(upstreamRequest.method, 'GET');
      assert.equal(upstreamRequest.url, '/products');
      assert.equal(upstreamRequest.url.startsWith('/api'), false);
    });
  });

  it('GW-U3 POST /orders forwards method, verbatim body and Idempotency-Key and returns 201 unchanged', async () => {
    await withHarness({}, async (harness) => {
      const response = await fetch(`${harness.gatewayUrl}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'order-key-1' },
        body: CREATE_ORDER_REQUEST_BODY,
      });

      assert.equal(response.status, 201);
      assert.equal(await response.text(), createdOrderBody());

      const upstreamRequest = harness.orders.requests[0];
      assert.equal(upstreamRequest.method, 'POST');
      assert.equal(upstreamRequest.url, '/orders');
      assert.equal(upstreamRequest.body, CREATE_ORDER_REQUEST_BODY);
      assert.equal(upstreamRequest.headers['idempotency-key'], 'order-key-1');
      assert.equal(upstreamRequest.headers['content-type'], 'application/json');
    });
  });

  it('GW-U3b never invents an Idempotency-Key when the client did not send one', async () => {
    await withHarness({}, async (harness) => {
      const response = await fetch(`${harness.gatewayUrl}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: CREATE_ORDER_REQUEST_BODY,
      });

      assert.equal(response.status, 201);
      assert.equal(harness.orders.requests.length, 1);
      assert.equal(harness.orders.requests[0].headers['idempotency-key'], undefined);
    });
  });

  it('GW-U4 POST /admin/orders/:id/ship is routed to orders POST /orders/:id/ship', async () => {
    await withHarness({}, async (harness) => {
      const response = await fetch(`${harness.gatewayUrl}/admin/orders/${ORDER_ID}/ship`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      assert.equal(response.status, 200);
      assert.equal(await response.text(), shippedOrderBody());
      assert.equal(harness.orders.requests.length, 1);

      const upstreamRequest = harness.orders.requests[0];
      assert.equal(upstreamRequest.method, 'POST');
      assert.equal(upstreamRequest.url, `/orders/${ORDER_ID}/ship`);
      assert.equal(upstreamRequest.body, '{}');
    });
  });

  for (const errorCase of errorCases) {
    it(`GW-U5 returns the upstream error status and body unchanged: ${errorCase.label}`, async () => {
      await withHarness(
        {
          ordersResponder: () => ({ status: errorCase.upstream.status, body: errorCase.upstream.body }),
        },
        async (harness) => {
          const response = await fetch(`${harness.gatewayUrl}${errorCase.request.path}`, {
            method: errorCase.request.method,
            headers: { 'content-type': 'application/json' },
            body: errorCase.request.body,
          });

          assert.equal(response.status, errorCase.upstream.status);
          assert.equal(await response.text(), errorCase.upstream.body);
          assert.match(response.headers.get('content-type') ?? '', /application\/json/);
          assert.ok(response.headers.get('x-correlation-id'));
          assert.equal(harness.orders.requests.length, 1);
        },
      );
    });
  }

  it('GW-U6 generates x-correlation-id when absent, forwards a supplied one and echoes it back', async () => {
    await withHarness({}, async (harness) => {
      const generated = await fetch(`${harness.gatewayUrl}/products`);
      const generatedId = generated.headers.get('x-correlation-id');

      assert.match(generatedId ?? '', UUID_V4);
      assert.equal(harness.inventory.requests[0].headers['x-correlation-id'], generatedId);

      const supplied = await fetch(`${harness.gatewayUrl}/products`, {
        headers: { 'x-correlation-id': 'corr-client-123' },
      });

      assert.equal(supplied.headers.get('x-correlation-id'), 'corr-client-123');
      assert.equal(harness.inventory.requests[1].headers['x-correlation-id'], 'corr-client-123');

      const posted = await fetch(`${harness.gatewayUrl}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr-client-456' },
        body: CREATE_ORDER_REQUEST_BODY,
      });

      assert.equal(posted.headers.get('x-correlation-id'), 'corr-client-456');
      assert.equal(harness.orders.requests[0].headers['x-correlation-id'], 'corr-client-456');
    });
  });

  it('GW-U9 exposes no cancellation route and no other new public route', async () => {
    await withHarness({}, async (harness) => {
      const cancel = await fetch(`${harness.gatewayUrl}/orders/${ORDER_ID}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(cancel.status, 404);

      const remove = await fetch(`${harness.gatewayUrl}/orders/${ORDER_ID}`, { method: 'DELETE' });
      assert.equal(remove.status, 404);

      const collection = await fetch(`${harness.gatewayUrl}/orders`);
      assert.equal(collection.status, 404);

      assert.equal(harness.orders.requests.length, 0);
      assert.equal(harness.inventory.requests.length, 0);
    });
  });

  it('registers exactly the five routes declared in the route table', async () => {
    assert.deepEqual(
      ROUTE_TABLE.map((route) => `${route.method} ${route.publicPath}`),
      ['GET /health', 'GET /products', 'POST /orders', 'GET /orders/:id', 'POST /admin/orders/:id/ship'],
    );

    await withHarness({}, async (harness) => {
      for (const route of ROUTE_TABLE) {
        const path = route.publicPath.replace(':id', ORDER_ID);
        const response = await fetch(`${harness.gatewayUrl}${path}`, {
          method: route.method,
          headers: { 'content-type': 'application/json' },
          body: route.method === 'POST' ? '{}' : undefined,
        });
        assert.notEqual(response.status, 404, `${route.method} ${route.publicPath} must be a declared route`);
      }

      for (const method of ['PUT', 'PATCH', 'DELETE']) {
        const response = await fetch(`${harness.gatewayUrl}/orders/${ORDER_ID}`, { method });
        assert.equal(response.status, 404, `${method} /orders/:id must not exist`);
      }
    });
  });

  it('answers CORS preflight for browser clients as the legacy deployment did', async () => {
    await withHarness({}, async (harness) => {
      const response = await fetch(`${harness.gatewayUrl}/products`, {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
      });

      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.equal(harness.inventory.requests.length, 0);
    });
  });

  it('preserves the upstream content-type on passthrough responses', async () => {
    await withHarness(
      {
        inventoryResponder: () => ({
          status: 200,
          body: PRODUCTS_BODY,
          contentType: 'application/json; charset=utf-8',
        }),
      },
      async (harness) => {
        const response = await fetch(`${harness.gatewayUrl}/products`);

        assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
        assert.equal(await response.text(), PRODUCTS_BODY);
      },
    );
  });

  it('rejects a body that is not JSON at the edge without contacting an upstream', async () => {
    await withHarness({}, async (harness) => {
      const response = await fetch(`${harness.gatewayUrl}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"productId":',
      });

      assert.equal(response.status, 400);
      assert.equal(harness.orders.requests.length, 0);
    });
  });
});
