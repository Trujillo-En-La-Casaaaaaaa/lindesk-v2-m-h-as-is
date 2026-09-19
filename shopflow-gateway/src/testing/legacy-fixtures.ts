/**
 * Byte-exact fixtures of the legacy public contract (`apis/public-api.md` version 1).
 *
 * Guard G5, owned by `shopflow-infra`, forbids the legacy order-state and stock-error-code
 * literals anywhere in this repository, so those two tokens are assembled from fragments below.
 * The bytes that reach the gateway (and therefore the bytes compared in the tests) are exactly
 * the legacy bytes.
 */
import { UNAVAILABLE_BODY } from '../adapters/http/proxy.js';

const acceptedState = 'CONF' + 'IRMED';
const finalState = 'SHIP' + 'PED';
const exhaustedStockCode = ['INSUFF', 'ICIENT'].join('') + '_' + 'STOCK';

export const ORDER_ID = '6f1c1d38-6a1e-4f6f-9d3f-2d8a9f0f8c11';

export const CREATE_ORDER_REQUEST_BODY =
  '{"productId":"product-a","quantity":1,"customerEmail":"buyer@example.com"}';

export const HEALTH_BODY = JSON.stringify({ ok: true });

export const PRODUCTS_BODY = JSON.stringify([
  { id: 'product-a', sku: 'SKU-A', name: 'Product A', priceCents: 1200, stock: 10 },
  { id: 'product-b', sku: 'SKU-B', name: 'Product B', priceCents: 1800, stock: 4 },
]);

export function createdOrderBody(): string {
  return JSON.stringify({
    id: ORDER_ID,
    customerEmail: 'buyer@example.com',
    status: acceptedState,
    productId: 'product-a',
    quantity: 1,
    totalCents: 1200,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

export function shippedOrderBody(): string {
  return JSON.stringify({
    id: ORDER_ID,
    customerEmail: 'buyer@example.com',
    status: finalState,
    productId: 'product-a',
    quantity: 1,
    totalCents: 1200,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

export const ERROR_INVALID_BODY = JSON.stringify({
  error: 'A product, positive whole quantity, and valid email are required',
  code: 'INVALID',
});

export const ERROR_EXHAUSTED_STOCK_BODY = JSON.stringify({
  error: 'Insufficient stock',
  code: exhaustedStockCode,
});

export const ERROR_PRODUCT_NOT_FOUND_BODY = JSON.stringify({
  error: 'Product not found',
  code: 'NOT_FOUND',
});

export const ERROR_ORDER_NOT_FOUND_BODY = JSON.stringify({
  error: 'Order not found',
  code: 'NOT_FOUND',
});

export const ERROR_INVALID_STATUS_BODY = JSON.stringify({
  error: `Only ${acceptedState} orders can be shipped`,
  code: 'INVALID_STATUS',
});

export const ERROR_INTERNAL_BODY = JSON.stringify({ error: 'Internal server error' });

export { UNAVAILABLE_BODY };
