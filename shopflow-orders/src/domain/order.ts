/**
 * The order aggregate as this service owns it.
 *
 * Only the two documented statuses exist: `CONFIRMED` (created by the order-creation saga) and
 * `SHIPPED` (the administrative transition). The intermediate states of the creation saga live in
 * `order_operations`, never in `orders.status`.
 */

export type OrderStatus = 'CONFIRMED' | 'SHIPPED';

/** One row of `orders`. */
export interface Order {
  readonly id: string;
  readonly customerEmail: string;
  readonly status: OrderStatus;
  readonly productId: string;
  readonly quantity: number;
  readonly totalCents: number;
  readonly createdAt: Date;
}

/** The wire shape of `apis/orders-service-api.md`: `createdAt` is an ISO 8601 UTC string. */
export interface OrderView {
  readonly id: string;
  readonly customerEmail: string;
  readonly status: OrderStatus;
  readonly productId: string;
  readonly quantity: number;
  readonly totalCents: number;
  readonly createdAt: string;
}

export function toOrderView(order: Order): OrderView {
  return {
    id: order.id,
    customerEmail: order.customerEmail,
    status: order.status,
    productId: order.productId,
    quantity: order.quantity,
    totalCents: order.totalCents,
    createdAt: order.createdAt.toISOString(),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Order ids are UUIDs. A path parameter that is not a UUID can never match a row, so the adapters
 * reject it as "unknown order" instead of letting PostgreSQL raise a cast error.
 */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** `priceCents * quantity`, the legacy definition of the order total. */
export function totalCentsOf(unitPriceCents: number, quantity: number): number {
  return unitPriceCents * quantity;
}
