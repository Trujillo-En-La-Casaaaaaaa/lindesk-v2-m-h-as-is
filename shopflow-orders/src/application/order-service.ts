/**
 * The read side of the order lifecycle plus the administrative transition.
 *
 * `GET /orders/:id`, `GET /orders/:id/operations` and `POST /orders/:id/ship`. Shipping is one
 * conditional `UPDATE ... WHERE status = 'CONFIRMED'` and touches neither inventory nor
 * notifications: that is what serializes concurrent ship calls of the same order.
 */

import { OrderNotFoundError, OrderNotShippableError } from '../domain/errors.js';
import { isUuid, toOrderView, type OrderView } from '../domain/order.js';
import { toOrderOperationView, type OrderOperationView } from '../domain/saga.js';
import type { OrderStore } from '../ports/order-store.js';

export class OrderService {
  constructor(private readonly store: OrderStore) {}

  async getOrder(orderId: string): Promise<OrderView> {
    return toOrderView(await this.requireOrder(orderId));
  }

  /**
   * `CONFIRMED` -> `SHIPPED` exactly once. An order id that is not a UUID can never match a row, so
   * it is reported as `404` instead of reaching PostgreSQL as a cast error.
   */
  async shipOrder(orderId: string): Promise<OrderView> {
    if (!isUuid(orderId)) {
      throw new OrderNotFoundError();
    }
    const outcome = await this.store.shipOrder(orderId);
    switch (outcome.kind) {
      case 'SHIPPED':
        return toOrderView(outcome.order);
      case 'NOT_CONFIRMED':
        throw new OrderNotShippableError();
      case 'NOT_FOUND':
        throw new OrderNotFoundError();
    }
  }

  /** The internal diagnostic of `GET /orders/:id/operations`. */
  async getOrderOperation(orderId: string): Promise<OrderOperationView> {
    if (!isUuid(orderId)) {
      throw new OrderNotFoundError();
    }
    const operation = await this.store.findOrderOperation(orderId);
    if (operation === null) {
      throw new OrderNotFoundError();
    }
    const outbox = await this.store.findOutboxEntryByOrderId(orderId);
    return toOrderOperationView(operation, outbox === null ? null : outbox.state);
  }

  private async requireOrder(orderId: string) {
    if (!isUuid(orderId)) {
      throw new OrderNotFoundError();
    }
    const order = await this.store.findOrderById(orderId);
    if (order === null) {
      throw new OrderNotFoundError();
    }
    return order;
  }
}
